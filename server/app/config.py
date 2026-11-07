"""Configurazione di Atlante: variabili d'ambiente + config.yaml."""
import os
import fnmatch
import yaml

STORAGE_ROOT = os.environ.get("ATLANTE_STORAGE", "/storage")
VAULT_ROOT = os.environ.get("ATLANTE_VAULT", "/vault")
DATA_DIR = os.environ.get("ATLANTE_DATA", "/data")
TOKEN = os.environ.get("ATLANTE_TOKEN", "")
CONFIG_FILE = os.environ.get("ATLANTE_CONFIG", "/app/config.yaml")
# percorsi sul server (fuori dal container): servono solo per mostrarli nelle pagine della wiki
STORAGE_LABEL = os.environ.get("ATLANTE_STORAGE_LABEL", "/mnt/storage").rstrip("/")
VAULT_LABEL = os.environ.get("ATLANTE_VAULT_LABEL", "/mnt/storage/vault").rstrip("/")

DEFAULTS = {
    "exclude": [
        "vault",
        "lost+found",
        "**/.Trash*",
        "**/@eaDir",
        "**/.DS_Store",
        "**/._*",
        "**/node_modules",
        "**/.git",
    ],
    "vault_exclude": [".trash", ".atlante", "**/.DS_Store"],
    "rescan_minutes": 30,
    "vault_rescan_seconds": 30,
    "text_max_mb": 50,
    "text_max_chars": 300_000,
    # i collegamenti suggeriti dall'LLM con fiducia da qui in su diventano link senza chiedere (0 = mai)
    "auto_accept": 0.8,
}


def load():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            user = yaml.safe_load(f) or {}
        cfg.update({k: v for k, v in user.items() if v is not None})
    except FileNotFoundError:
        pass
    return cfg


CFG = load()


def is_excluded(rel: str, name: str, patterns) -> bool:
    """rel = percorso relativo alla radice, name = nome del file/cartella."""
    for p in patterns:
        if p.startswith("**/"):
            if fnmatch.fnmatch(name, p[3:]):
                return True
        elif fnmatch.fnmatch(rel, p):
            return True
    return False
