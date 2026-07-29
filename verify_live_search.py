import requests

url = "https://inspectallamado.dondlingergc.com/api/search"
payload = {
    "query": "who is john dondlinger",
    "deepCrawl": True,
    "mode": "deep_reasoning"
}
headers = {"x-user-id": "johndondlinger21@gmail.com"}

try:
    res = requests.post(url, json=payload, headers=headers, timeout=25)
    print("STATUS:", res.status_code)
    print("RESPONSE:")
    print(res.text[:1500])
except Exception as e:
    print("ERROR:", e)
