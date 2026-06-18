"""
Camera Roll backend entry point (thin launcher).

This file is deliberately tiny. On Windows the process pool spawns workers by
re-importing the __main__ module, so keeping the heavy web stack (FastAPI,
uvicorn) out of this module's top level means each worker starts in a fraction
of the time. The actual server lives in app.py; the image workers in imaging.py.

Run:  python main.py   (PHOTOVIEWER_PORT selects the port, default 8756)
"""

import os

if __name__ == "__main__":
    import uvicorn

    from app import app

    port = int(os.environ.get("PHOTOVIEWER_PORT", "8756"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
