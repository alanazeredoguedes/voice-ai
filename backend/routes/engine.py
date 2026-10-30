from fastapi import APIRouter, Request

router = APIRouter(prefix="/engine", tags=["engine"])


@router.post("/restart")
async def restart_engine(request: Request) -> dict:
    orchestrator = request.app.state.orchestrator
    if not orchestrator:
        return {"status": "orchestrator_not_ready"}
    await orchestrator.restart_engine()
    return {"status": "restarted"}
