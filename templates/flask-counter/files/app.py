"""Flask starter: counts visits in the app's SQLite database (SQLITE_PATH)."""
import os
import sqlite3

from flask import Flask, render_template

app = Flask(__name__)
DB = os.environ.get("SQLITE_PATH") or os.path.join(os.environ.get("DATA_DIR", "."), "data.db")


def db():
    conn = sqlite3.connect(DB)
    conn.execute("CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, at TEXT DEFAULT CURRENT_TIMESTAMP)")
    return conn


@app.route("/")
def index():
    with db() as conn:
        conn.execute("INSERT INTO visits DEFAULT VALUES")
        count = conn.execute("SELECT COUNT(*) FROM visits").fetchone()[0]
    return render_template("index.html", count=count)


@app.route("/health")
def health():
    return {"ok": True}


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 3000)))
