<?php
/**
 * CoinVello + Laravel (10.x / 11.x). Single controller: start-payment action + verified webhook.
 *
 * AI instructions: save as app/Http/Controllers/CoinVelloController.php; add to routes/web.php:
 *     Route::post('/pay/{orderId}', [CoinVelloController::class, 'startPayment']);
 *     Route::post('/webhooks/coinvello', [CoinVelloController::class, 'webhook'])
 *         ->withoutMiddleware([\Illuminate\Foundation\Http\Middleware\ValidateCsrfToken::class]);   // Laravel 11
 *     // Laravel 10: add '/webhooks/coinvello' to $except in App\Http\Middleware\VerifyCsrfToken instead.
 *     Route::get('/orders/{orderId}/thanks', [CoinVelloController::class, 'thanks']);
 * Add to config/services.php:  'coinvello' => ['key' => env('COINVELLO_API_KEY'), 'secret' => env('COINVELLO_WEBHOOK_SECRET'),
 *                                               'base' => env('COINVELLO_API_BASE', 'https://api.coinvello.com/v1')],
 * and the three variables to .env / .env.example. Replace the TODO store methods with Eloquent models.
 * The webhook reads $request->getContent() (raw body); never rebuild JSON from $request->all().
 */

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use RuntimeException;

class CoinVelloController extends Controller
{
    // --- TODO: replace with Eloquent (Order model, ProcessedWebhookEvent with unique event_id) --------
    private static array $orders = [];
    private static array $processed = [];

    private function loadOrder(string $id): array
    {
        return self::$orders[$id] ??= ['id' => $id, 'total' => '49.99', 'status' => 'unpaid'];
    }

    private function saveOrder(array $order): void
    {
        self::$orders[$order['id']] = $order;
    }
    // --------------------------------------------------------------------------------------------------

    /** Call the CoinVello API. Throws RuntimeException with the error code as the message prefix. */
    private function coinvello(string $method, string $path, ?array $body = null, ?string $idempotencyKey = null): array
    {
        $request = Http::withToken(config('services.coinvello.key'))->acceptJson()->timeout(20);
        if ($idempotencyKey) {
            $request = $request->withHeaders(['Idempotency-Key' => $idempotencyKey]);
        }
        $response = $request->send($method, config('services.coinvello.base') . $path, $body === null ? [] : ['json' => $body]);
        if ($response->failed()) {
            $error = $response->json('error') ?? [];
            throw new RuntimeException(($error['code'] ?? 'http_' . $response->status()) . ': ' . ($error['message'] ?? 'CoinVello error'), $response->status());
        }
        return $response->json();
    }

    /** CoinVello-Signature: t=<unix>,v1=<hex>[,v1=<hex>]; HMAC-SHA256 over "<t>.<raw body>" with the whsec_ secret. */
    public static function verifySignature(string $raw, string $header, string $secret, int $tolerance = 300): array
    {
        $t = 0; $sigs = [];
        foreach (explode(',', $header) as $pair) {
            $kv = explode('=', trim($pair), 2);
            if (count($kv) !== 2) continue;
            if ($kv[0] === 't')  { $t = (int) $kv[1]; }
            if ($kv[0] === 'v1') { $sigs[] = $kv[1]; }
        }
        if ($t === 0 || abs(time() - $t) > $tolerance) {
            throw new RuntimeException('timestamp outside tolerance');
        }
        $expected = hash_hmac('sha256', $t . '.' . $raw, $secret);
        foreach ($sigs as $sig) {
            if (hash_equals($expected, $sig)) {
                return json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
            }
        }
        throw new RuntimeException('signature mismatch');
    }

    /** 1. Create a hosted checkout session and redirect the customer to it. */
    public function startPayment(string $orderId)
    {
        $order = $this->loadOrder($orderId);
        try {
            $session = $this->coinvello('POST', '/checkout-sessions', [
                'amount'          => (string) $order['total'],          // decimal string, never a float
                'currency'        => 'USD',
                'accepted_assets' => ['btc:bitcoin', 'eth:ethereum', 'usdc:polygon', 'usdt:tron'],
                'order_id'        => $order['id'],
                'success_url'     => url("/orders/{$order['id']}/thanks"),
                'cancel_url'      => url("/orders/{$order['id']}"),
                'metadata'        => ['order_id' => (string) $order['id']],
            ], "order-{$order['id']}-checkout");
        } catch (RuntimeException $e) {
            if (str_starts_with($e->getMessage(), 'insufficient_credits')) {
                return response('Crypto payments temporarily unavailable', 503);
            }
            throw $e;
        }
        $this->saveOrder($order + ['checkout_session_id' => $session['id'], 'invoice_id' => $session['invoice_id']]);
        return redirect()->away($session['url'], 303);
    }

    /** 2. Raw body -> verify -> dedupe -> fulfil on invoice.paid. Must answer 2xx within 10 s. */
    public function webhook(Request $request)
    {
        try {
            $event = self::verifySignature($request->getContent(), $request->header('CoinVello-Signature', ''), config('services.coinvello.secret'));
        } catch (\Throwable $e) {
            return response('Webhook error: ' . $e->getMessage(), 400);
        }
        if (isset(self::$processed[$event['id']])) {
            return response()->json(['received' => true]);
        }
        $inv   = $event['data']['object'];
        $order = isset($inv['order_id']) ? $this->loadOrder($inv['order_id']) : null;
        if ($event['type'] === 'invoice.paid' && $order) {
            $this->saveOrder(['status' => 'paid'] + $order);           // fulfil here (or dispatch a queued job)
        } elseif (in_array($event['type'], ['invoice.underpaid', 'invoice.overpaid', 'invoice.expired'], true) && $order) {
            $this->saveOrder(['status' => explode('.', $event['type'])[1]] + $order);
        }
        self::$processed[$event['id']] = true;
        return response()->json(['received' => true]);
    }

    /** 3. Success page: show live status, never mark paid here. */
    public function thanks(string $orderId)
    {
        $order = $this->loadOrder($orderId);
        $inv   = isset($order['invoice_id']) ? $this->coinvello('GET', '/invoices/' . $order['invoice_id']) : null;
        return response()->json(['order' => $order['id'], 'invoice_status' => $inv['status'] ?? null, 'local_status' => $order['status']]);
    }
}
