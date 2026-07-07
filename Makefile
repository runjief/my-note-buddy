.PHONY: install dev build

install:
	cd backend && pip install -r requirements.txt
	cd frontend && npm install

dev:
	@echo "Starting backend on :8000 and frontend on :5173"
	@cd backend && uvicorn main:app --reload --port 8000 &
	@cd frontend && npm run dev

stop:
	@pkill -f "uvicorn main:app" 2>/dev/null || true
	@pkill -f "vite" 2>/dev/null || true

build:
	cd frontend && npm run build

serve: build
	@echo "Serving on http://localhost:8000"
	cd backend && uvicorn main:app --port 8000
