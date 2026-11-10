from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    manager = ws.app.state.ws_manager
    state = ws.app.state.state_manager
    await manager.connect(ws)
    try:
        # envia snapshot inicial
        await ws.send_json({"type": "state_changed", "state": state.state})
        while True:
            msg = await ws.receive_text()
            # ping/pong simples; cliente pode mandar qualquer coisa pra manter vivo
            if msg == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(ws)
