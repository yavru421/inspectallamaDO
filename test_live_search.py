import requests
import json

url = "https://inspectallamado.dondlingergc.com/api/search"
payload = {
    "query": "who is john dondlinger",
    "deepCrawl": True,
    "mode": "deep_reasoning"
}

headers = {
    "Content-Type": "application/json",
    "x-user-id": "johndondlinger21@gmail.com"
}

try:
    print("Sending POST request to /api/search...")
    res = requests.post(url, json=payload, headers=headers, timeout=60)
    print("Status Code:", res.status_code)
    print("Headers:", res.headers)
    print("Body snippet:", res.text[:1000])
except Exception as e:
    print("Request failed:", e)
