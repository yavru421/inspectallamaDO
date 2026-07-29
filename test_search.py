import requests
import json
import time

url = "https://inspectallamado.dondlingergc.com/api/search"

payload_standard = {
    "query": "Cloudflare Workers AI",
    "deepCrawl": False,
    "mode": "standard"
}

print("Testing Standard Search Mode...")
start = time.time()
try:
    res = requests.post(url, json=payload_standard, timeout=60)
    elapsed = time.time() - start
    print(f"Status Code: {res.status_code} in {elapsed:.2f}s")
    if res.status_code == 200:
        data = res.json()
        print("Query:", data.get("query"))
        print("Synthesis snippet:", str(data.get("synthesis"))[:200])
    else:
        print("Error Response:", res.text)
except Exception as e:
    print(f"Exception after {time.time() - start:.2f}s: {e}")

print("\nTesting Deep Reasoning Search Mode...")
payload_deep = {
    "query": "Durable Objects vs Redis performance",
    "deepCrawl": True,
    "mode": "deep_reasoning"
}
start = time.time()
try:
    res = requests.post(url, json=payload_deep, timeout=90)
    elapsed = time.time() - start
    print(f"Status Code: {res.status_code} in {elapsed:.2f}s")
    if res.status_code == 200:
        data = res.json()
        print("Query:", data.get("query"))
        print("Mode:", data.get("mode"))
        print("Claims count:", len(data.get("claims", [])))
        print("Entities count:", len(data.get("entities", [])))
        print("Synthesis snippet:", str(data.get("synthesis"))[:200])
    else:
        print("Error Response:", res.text)
except Exception as e:
    print(f"Exception after {time.time() - start:.2f}s: {e}")
