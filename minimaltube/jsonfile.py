"""MinimalTube server - JSON files: read tolerantly, written whole or not at all."""
import json
import threading

from .system import replace_file


def read_json(path, default):
    """Parse a JSON file.

    Args:
        path (Path): The file.
        default: What to return when the file is missing, isn't JSON, or holds another type
            than `default` itself (a list where a dict was expected).

    Returns:
        The parsed value, or `default`.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default
    return data if isinstance(data, type(default)) else default


def write_json_atomic(path, data, label: str = "json") -> bool:
    """Write JSON through a temp file, so a crash never leaves half a file and a reader never
    sees one. Each thread writes its own temp file: the same file can be written from two
    threads at once (the last one wins).

    Args:
        path (Path): The file to (re)place.
        data: Anything json.dumps takes.
        label (str): Names the caller in the log line when the write fails.

    Returns:
        bool: False when it couldn't be written (logged, not raised).
    """
    tmp = path.with_name(f"{path.name}.{threading.get_ident()}.tmp")
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        replace_file(tmp, path)
        return True
    except OSError as e:
        print(f"[{label}] couldn't save {path.name}: {e}")
        try:
            tmp.unlink()
        except OSError:
            pass
        return False
