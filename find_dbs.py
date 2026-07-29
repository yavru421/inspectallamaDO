import duckdb
import glob
import os

files = glob.glob(r'C:\Users\John\.gemini\**\*.duckdb', recursive=True)
print("DuckDB files found:", files)

for f in files[:3]:
    try:
        con = duckdb.connect(f, read_only=True)
        tables = con.execute("SHOW TABLES").fetchall()
        print(f, "Tables:", tables)
    except Exception as e:
        print(f, "Error:", e)
