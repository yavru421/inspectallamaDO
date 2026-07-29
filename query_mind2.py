import duckdb

con = duckdb.connect(r'C:\Users\John\.gemini\config\agent_memory.duckdb', read_only=True)
rows = con.execute("""
    SELECT content FROM transcripts 
    WHERE LOWER(content) LIKE '%inspectallama%' 
    ORDER BY rowid DESC LIMIT 5
""").fetchall()

print("--- Transcripts Ground Truth ---")
for r in rows:
    safe_text = r[0][:300].encode('ascii', errors='replace').decode('ascii')
    print(safe_text)
    print("="*40)
