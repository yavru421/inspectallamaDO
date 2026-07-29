import requests

url = "https://inspectallamado.dondlingergc.com/api/stripe/checkout"
headers = {"x-user-id": "johndondlinger21@gmail.com"}

try:
    res = requests.post(url, headers=headers, timeout=10)
    print("Status:", res.status_code)
    print("Response JSON:", res.json())
except Exception as e:
    print("Error:", e)
