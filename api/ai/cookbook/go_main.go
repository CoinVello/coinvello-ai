// CoinVello + Go net/http (Go 1.21+). Single file: start-payment handler + verified webhook. Stdlib only.
// AI instructions: go run go_main.go; move the two handlers into the project router (chi/gin/echo expose the raw
// body via r.Body); replace the in-memory maps with the database. Decimal amounts stay strings, never float64.
// Env:  COINVELLO_API_KEY=cv_test_...  COINVELLO_WEBHOOK_SECRET=whsec_...  APP_URL=http://localhost:3000
//       COINVELLO_API_BASE=https://api.coinvello.com/v1 (or http://localhost:4242/v1 for the mock)
// Test: see README.md (register http://localhost:3000/webhooks/coinvello as webhook, simulate a payment).
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	apiBase = envOr("COINVELLO_API_BASE", "https://api.coinvello.com/v1")
	apiKey  = os.Getenv("COINVELLO_API_KEY")
	secret  = os.Getenv("COINVELLO_WEBHOOK_SECRET")
	appURL  = envOr("APP_URL", "http://localhost:3000")

	mu        sync.Mutex
	orders    = map[string]map[string]string{} // TODO: your DB. order id -> {status, invoice_id, checkout_session_id}
	processed = map[string]bool{}              // TODO: your DB. webhook event ids, keep >= 3 days
)

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
// coinvello calls the API; on 4xx/5xx it returns the CoinVello error code (e.g. "insufficient_credits") and an error.
func coinvello(method, path string, body any, idempotencyKey string, out any) (code string, err error) {
	var buf io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		buf = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, apiBase+path, buf)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	res, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 400 {
		var env struct{ Error struct{ Code, Message string } }
		_ = json.Unmarshal(raw, &env)
		return env.Error.Code, errors.New("coinvello " + strconv.Itoa(res.StatusCode) + " " + env.Error.Code + ": " + env.Error.Message)
	}
	return "", json.Unmarshal(raw, out)
}
// verifyCoinVelloSignature: header "t=<unix>,v1=<hex>[,v1=<hex>]"; HMAC-SHA256 over "<t>.<raw body>"; 300 s tolerance.
func verifyCoinVelloSignature(rawBody []byte, header, secret string, tolerance time.Duration) (map[string]any, error) {
	t, sigs := int64(0), []string(nil)
	for _, part := range strings.Split(header, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) == 2 && kv[0] == "t" {
			t, _ = strconv.ParseInt(kv[1], 10, 64)
		} else if len(kv) == 2 && kv[0] == "v1" {
			sigs = append(sigs, kv[1])
		}
	}
	if t == 0 || math.Abs(float64(time.Now().Unix()-t)) > tolerance.Seconds() {
		return nil, errors.New("timestamp outside tolerance")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(t, 10) + "."))
	mac.Write(rawBody)
	expected := mac.Sum(nil)
	for _, s := range sigs {
		if b, err := hex.DecodeString(s); err == nil && hmac.Equal(b, expected) {
			var ev map[string]any
			return ev, json.Unmarshal(rawBody, &ev)
		}
	}
	return nil, errors.New("signature mismatch")
}

// 1. Create a hosted checkout session and redirect the customer to it.
func startPayment(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/pay/")
	var session map[string]any // CheckoutSession: id, url, invoice_id, status, expires_at ...
	code, err := coinvello("POST", "/checkout-sessions", map[string]any{
		"amount": "49.99", "currency": "USD", // decimal string from your order record
		"accepted_assets": []string{"btc:bitcoin", "eth:ethereum", "usdc:polygon", "usdt:tron"},
		"order_id": id, "success_url": appURL + "/orders/" + id + "/thanks", "cancel_url": appURL + "/orders/" + id,
		"metadata": map[string]string{"order_id": id},
	}, "order-"+id+"-checkout", &session)
	if err != nil {
		msg, status := err.Error(), http.StatusBadGateway
		if code == "insufficient_credits" {
			msg, status = "Crypto payments temporarily unavailable", http.StatusServiceUnavailable
		}
		http.Error(w, msg, status)
		return
	}
	mu.Lock()
	orders[id] = map[string]string{"status": "unpaid", "invoice_id": session["invoice_id"].(string), "checkout_session_id": session["id"].(string)}
	mu.Unlock()
	http.Redirect(w, r, session["url"].(string), http.StatusSeeOther)
}

// 2. Raw body -> verify -> dedupe -> fulfil on invoice.paid. Answer 2xx within 10 s.
func webhook(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	ev, err := verifyCoinVelloSignature(raw, r.Header.Get("CoinVello-Signature"), secret, 300*time.Second)
	if err != nil {
		http.Error(w, "Webhook error: "+err.Error(), http.StatusBadRequest)
		return
	}
	id, typ := ev["id"].(string), ev["type"].(string)
	oid, _ := ev["data"].(map[string]any)["object"].(map[string]any)["order_id"].(string)
	mu.Lock()
	defer mu.Unlock()
	if o := orders[oid]; o != nil && !processed[id] {
		switch typ {
		case "invoice.paid":
			o["status"] = "paid" // fulfil here (or enqueue)
		case "invoice.underpaid", "invoice.overpaid", "invoice.expired":
			o["status"] = strings.TrimPrefix(typ, "invoice.")
		}
	}
	processed[id] = true
	w.WriteHeader(http.StatusOK)
}

func main() {
	http.HandleFunc("/pay/", startPayment)
	http.HandleFunc("/webhooks/coinvello", webhook)
	log.Printf("listening on %s (API %s)", appURL, apiBase)
	log.Fatal(http.ListenAndServe(":3000", nil))
}
