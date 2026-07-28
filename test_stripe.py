import json
import subprocess
import urllib.parse
import urllib.request

# Use pwsh.exe directly (PowerShell 7)
cmd = ['pwsh.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', r'C:\Users\John\.gemini\config\skills\secrets-vault\scripts\vault.ps1', 'get', 'stripe/restricted-key']

res = subprocess.run(cmd, capture_output=True, text=True)
stripe_key = res.stdout.strip()

print(f"[INFO] Retrieved secret key length: {len(stripe_key)}")

if not stripe_key:
    print("[ERROR] Failed to retrieve secret key.")
    print("STDERR:", res.stderr)
    exit(1)

# Test Stripe Checkout Sessions API directly
data = urllib.parse.urlencode({
    'payment_method_types[]': 'card',
    'mode': 'subscription',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': 'InspectaLlama Pro Pass',
    'line_items[0][price_data][product_data][description]': 'Unlimited Deep Web Search & 70B Llama AI',
    'line_items[0][price_data][unit_amount]': '999',
    'line_items[0][price_data][recurring][interval]': 'month',
    'line_items[0][quantity]': '1',
    'success_url': 'https://inspectallama-do.dondlingergeneralcontracting.workers.dev/?payment=success',
    'cancel_url': 'https://inspectallama-do.dondlingergeneralcontracting.workers.dev/?payment=cancel',
    'client_reference_id': 'test_user_123'
}).encode('utf-8')

req = urllib.request.Request(
    'https://api.stripe.com/v1/checkout/sessions',
    data=data,
    headers={
        'Authorization': f'Bearer {stripe_key}',
        'Content-Type': 'application/x-www-form-urlencoded'
    },
    method='POST'
)

try:
    with urllib.request.urlopen(req) as response:
        body = response.read().decode('utf-8')
        session_data = json.loads(body)
        print("\n==========================================")
        print("SUCCESS! STRIPE CHECKOUT API VERIFICATION PASSED!")
        print(f"Generated Checkout URL: {session_data.get('url')}")
        print(f"Checkout Session ID: {session_data.get('id')}")
        print(f"Payment Status: {session_data.get('payment_status')}")
        print("==========================================\n")
except Exception as e:
    print("\nSTRIPE API ERROR:", e)
    if hasattr(e, 'read'):
        print("Response details:", e.read().decode('utf-8'))
