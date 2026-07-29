import subprocess

cmd = ['pwsh.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', r'C:\Users\John\.gemini\config\skills\secrets-vault\scripts\vault.ps1', 'get', 'stripe/restricted-key']
res = subprocess.run(cmd, capture_output=True, text=True)
stripe_key = res.stdout.strip()

if not stripe_key:
    print("ERROR: key is empty")
    exit(1)

print(f"Key found (length {len(stripe_key)})")

p = subprocess.Popen(['npx.cmd', 'wrangler', 'secret', 'put', 'STRIPE_SECRET_KEY'], stdin=subprocess.PIPE, text=True)
p.communicate(input=stripe_key)
print("Return code:", p.returncode)
