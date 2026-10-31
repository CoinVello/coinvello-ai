# CoinVello + Sinatra (Ruby 3.x). Single file: start-payment route + webhook with manual HMAC verification.
#
# AI instructions: `gem install sinatra puma`, set the env vars below, `ruby sinatra_app.rb`, and replace the
# TODO store methods with the project's models (ActiveRecord / Sequel). In Rails, the same code goes in a
# controller with `skip_before_action :verify_authenticity_token` and `request.raw_post` for the raw body.
#
# Env:  COINVELLO_API_KEY=cv_test_...  COINVELLO_WEBHOOK_SECRET=whsec_...
#       COINVELLO_API_BASE=https://api.coinvello.com/v1 (or http://localhost:4242/v1 for the mock)  APP_URL=http://localhost:3000
# Run:  ruby sinatra_app.rb -p 3000   ->  POST http://localhost:3000/pay/ORDER-1
# Test: see README.md (register http://localhost:3000/webhooks/coinvello as webhook, simulate a payment).
require "sinatra"
require "json"
require "net/http"
require "openssl"
require "uri"

API     = ENV.fetch("COINVELLO_API_BASE", "https://api.coinvello.com/v1")
KEY     = ENV.fetch("COINVELLO_API_KEY")
SECRET  = ENV.fetch("COINVELLO_WEBHOOK_SECRET", "")
APP_URL = ENV.fetch("APP_URL", "http://localhost:3000")

# --- TODO: replace with your database ---------------------------------------------------------------
ORDERS    = {}
PROCESSED = {}
def load_order(id)  = ORDERS[id] ||= { "id" => id, "total" => "49.99", "status" => "unpaid" }
def save_order(o)   = ORDERS[o["id"]] = o
# ---------------------------------------------------------------------------------------------------

class CoinVelloError < StandardError
  attr_reader :status, :code
  def initialize(status, error)
    @status, @code = status, error["code"]
    super(error["message"] || "CoinVello #{status}")
  end
end

def coinvello(method, path, body = nil, idempotency_key: nil)
  uri = URI("#{API}#{path}")
  req = Net::HTTP.const_get(method.capitalize).new(uri)
  req["Authorization"] = "Bearer #{KEY}"
  req["Content-Type"] = "application/json"
  req["Idempotency-Key"] = idempotency_key if idempotency_key
  req.body = JSON.generate(body) if body
  res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", read_timeout: 20) { |h| h.request(req) }
  data = res.body.to_s.empty? ? {} : JSON.parse(res.body)
  raise CoinVelloError.new(res.code.to_i, data["error"] || {}) if res.code.to_i >= 400
  data
end

# CoinVello-Signature: t=<unix>,v1=<hex>[,v1=<hex>]; HMAC-SHA256 over "<t>.<raw body>" keyed with the whsec_ secret.
def verify_coinvello_signature(raw_body, header, secret, tolerance: 300)
  t = 0
  sigs = []
  header.to_s.split(",").each do |part|
    k, v = part.strip.split("=", 2)
    t = v.to_i if k == "t"
    sigs << v if k == "v1"
  end
  raise "timestamp outside tolerance" if t.zero? || (Time.now.to_i - t).abs > tolerance
  expected = OpenSSL::HMAC.hexdigest("SHA256", secret, "#{t}.#{raw_body}")
  ok = sigs.any? { |s| s.bytesize == expected.bytesize && OpenSSL.fixed_length_secure_compare(s, expected) }
  raise "signature mismatch" unless ok
  JSON.parse(raw_body)
end

# 1. Create a hosted checkout session and redirect the customer to it.
post "/pay/:order_id" do
  order = load_order(params[:order_id])
  begin
    session = coinvello("POST", "/checkout-sessions", {
      "amount" => order["total"],                       # decimal string, never a float
      "currency" => "USD",
      "accepted_assets" => %w[btc:bitcoin eth:ethereum usdc:polygon usdt:tron],
      "order_id" => order["id"],
      "success_url" => "#{APP_URL}/orders/#{order['id']}/thanks",
      "cancel_url" => "#{APP_URL}/orders/#{order['id']}",
      "metadata" => { "order_id" => order["id"] },
    }, idempotency_key: "order-#{order['id']}-checkout")
  rescue CoinVelloError => e
    halt(e.code == "insufficient_credits" ? 503 : 502, e.message)
  end
  save_order(order.merge("checkout_session_id" => session["id"], "invoice_id" => session["invoice_id"]))
  redirect session["url"], 303
end

# 2. Raw body -> verify -> dedupe -> fulfil on invoice.paid. Answer 2xx within 10 s.
post "/webhooks/coinvello" do
  raw = request.body.read
  begin
    event = verify_coinvello_signature(raw, request.env["HTTP_COINVELLO_SIGNATURE"], SECRET)
  rescue StandardError => e
    halt 400, "Webhook error: #{e.message}"
  end
  return JSON.generate(received: true) if PROCESSED[event["id"]]
  inv   = event["data"]["object"]
  order = inv["order_id"] && load_order(inv["order_id"])
  case event["type"]
  when "invoice.paid"
    save_order(order.merge("status" => "paid")) if order              # fulfil here (or enqueue a job)
  when "invoice.underpaid", "invoice.overpaid", "invoice.expired"
    save_order(order.merge("status" => event["type"].split(".").last)) if order
  end
  PROCESSED[event["id"]] = true
  content_type :json
  JSON.generate(received: true)
end

# 3. Success page: show live status, never mark paid here.
get "/orders/:order_id/thanks" do
  order = load_order(params[:order_id])
  inv = order["invoice_id"] && coinvello("GET", "/invoices/#{order['invoice_id']}")
  content_type :json
  JSON.generate(order: order["id"], invoice_status: inv && inv["status"], local_status: order["status"])
end
