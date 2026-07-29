import sys
sys.path.append(r'C:\Users\John\.gemini\config')
try:
    from db_session import get_unified_connection
    con = get_unified_connection()
    rows = con.execute("SELECT content FROM agent_memory.transcripts WHERE LOWER(content) LIKE '%inspectallama%' ORDER BY rowid DESC LIMIT 5").fetchall()
    print("Found rows:", len(rows))
    for r in rows:
        print("-", r[0][:200])
except Exception as e:
    print("Error querying DuckDB:", e)
