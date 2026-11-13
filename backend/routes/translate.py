import asyncio
import importlib.util
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel


def _require_argos() -> None:
    """O motor de tradução (argostranslate, com o torch) é baixado na instalação do app (os idiomas, não: esses o
    usuário baixa na aba Traduzir). Se o motor ainda não está aí (instalação interrompida), avisa em vez de dar erro."""
    if importlib.util.find_spec("argostranslate") is None:
        raise HTTPException(503, "O motor de tradução ainda não foi instalado. Feche e abra o app para concluir a instalação.")


router = APIRouter(prefix="/translate", tags=["translate"], dependencies=[Depends(_require_argos)])

# Cache do índice de pacotes para evitar bater no servidor Argos a cada request
_package_index_cache: list | None = None
_package_index_ts: float = 0.0
_CACHE_TTL = 3600  # 1 hora


class InstallBody(BaseModel):
    from_code: str
    to_code: str


class TranslateBody(BaseModel):
    text: str
    from_code: str
    to_code: str


def _get_installed_map() -> dict[str, object]:
    import argostranslate.package as pkg
    return {
        f"{p.from_code}>{p.to_code}": p
        for p in pkg.get_installed_packages()
    }


def _fetch_index() -> list:
    global _package_index_cache, _package_index_ts
    now = time.time()
    if _package_index_cache is not None and (now - _package_index_ts) < _CACHE_TTL:
        return _package_index_cache
    import argostranslate.package as pkg
    pkg.update_package_index()
    _package_index_cache = pkg.get_available_packages()
    _package_index_ts = now
    return _package_index_cache


@router.get("/packages")
async def list_packages() -> list[dict]:
    installed = await asyncio.to_thread(_get_installed_map)
    available = await asyncio.to_thread(_fetch_index)
    result = []
    for p in available:
        key = f"{p.from_code}>{p.to_code}"
        result.append({
            "from_code": p.from_code,
            "from_name": p.from_name,
            "to_code": p.to_code,
            "to_name": p.to_name,
            "size_mb": round(getattr(p, "size", 0) / 1_048_576, 1),
            "installed": key in installed,
        })
    # Ordenar: instalados primeiro, depois por nome
    result.sort(key=lambda x: (not x["installed"], x["from_name"], x["to_name"]))
    return result


@router.post("/packages/install", status_code=202)
async def install_package(
    body: InstallBody,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    state = request.app.state.orchestrator.state

    available = await asyncio.to_thread(_fetch_index)
    pkg_to_install = next(
        (p for p in available if p.from_code == body.from_code and p.to_code == body.to_code),
        None,
    )
    if pkg_to_install is None:
        raise HTTPException(404, f"Par {body.from_code}→{body.to_code} não encontrado")

    def do_install():
        import argostranslate.package as pkg

        tmp = tempfile.NamedTemporaryFile(suffix=".argosmodel", delete=False)
        tmp_path = tmp.name
        tmp.close()

        try:
            import requests as req
            headers = {"User-Agent": "Mozilla/5.0 (compatible; ArgosTranslate/1.0)"}
            with req.get(pkg_to_install.links[0], stream=True, headers=headers, timeout=600) as r:
                r.raise_for_status()
                total = int(r.headers.get("content-length", 0))
                downloaded = 0
                with open(tmp_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=65536):
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total > 0:
                            pct = min(downloaded / total * 100, 99.0)
                            state.emit({
                                "type": "translate_download_progress",
                                "from_code": body.from_code,
                                "to_code": body.to_code,
                                "progress": round(pct, 1),
                                "done": False,
                            })
            pkg.install_from_path(tmp_path)
        finally:
            Path(tmp_path).unlink(missing_ok=True)

        state.emit({
            "type": "translate_download_progress",
            "from_code": body.from_code,
            "to_code": body.to_code,
            "progress": 100.0,
            "done": True,
        })

    background_tasks.add_task(asyncio.to_thread, do_install)
    return {"queued": True}


@router.delete("/packages/{from_code}/{to_code}", status_code=204)
async def remove_package(from_code: str, to_code: str) -> None:
    installed = await asyncio.to_thread(_get_installed_map)
    key = f"{from_code}>{to_code}"
    pkg = installed.get(key)
    if pkg is None:
        raise HTTPException(404, f"Par {from_code}→{to_code} não está instalado")

    def do_remove():
        import argostranslate.package as ap
        ap.uninstall(pkg)

    await asyncio.to_thread(do_remove)


@router.post("/text")
async def translate_text(body: TranslateBody, request: Request) -> dict:
    if not body.text.strip():
        return {"translated": "", "from_code": body.from_code, "to_code": body.to_code}

    installed = await asyncio.to_thread(_get_installed_map)
    key = f"{body.from_code}>{body.to_code}"
    if key not in installed:
        raise HTTPException(400, f"Modelo {body.from_code}→{body.to_code} não está instalado")

    # Usar GPU se disponível (mesmo device do Whisper)
    engine = request.app.state.orchestrator.engine
    if engine:
        import argostranslate.settings as argos_settings
        argos_settings.device = engine._loaded_device

    def do_translate():
        import argostranslate.translate as at
        return at.translate(body.text, body.from_code, body.to_code)

    translated = await asyncio.to_thread(do_translate)
    return {"translated": translated, "from_code": body.from_code, "to_code": body.to_code}
