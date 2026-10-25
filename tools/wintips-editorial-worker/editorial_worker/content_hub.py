"""Opt-in loader for the one versioned RDJ hub checkout. No copied runtime."""
import importlib.util
import os
from pathlib import Path
import sys


def module():
    if not os.environ.get('RDJ_CONTENT_HUB_DIR'): return None
    root = Path(os.environ.get('RDJ_HUB_CODE_ROOT', ''))
    if not root.is_absolute() or root.is_symlink() or root.resolve() != root.absolute():
        raise ValueError('rdj_hub_code_root_invalid')
    entry = root / 'rdj_hub' / '__init__.py'
    if entry.is_symlink() or not entry.is_file() or entry.resolve() != entry.absolute():
        raise ValueError('rdj_hub_code_missing')
    loaded = sys.modules.get('rdj_hub')
    if loaded is None:
        spec = importlib.util.spec_from_file_location('rdj_hub', entry, submodule_search_locations=[str(entry.parent)])
        loaded = importlib.util.module_from_spec(spec)
        sys.modules['rdj_hub'] = loaded
        try: spec.loader.exec_module(loaded)
        except BaseException:
            sys.modules.pop('rdj_hub', None)
            raise
    if Path(loaded.__file__).resolve() != entry.resolve() or loaded.API_VERSION != 'rdj-hub-v1':
        raise ValueError('rdj_hub_code_version_invalid')
    return loaded


def open_hub(edition=None):
    loaded = module()
    return loaded.open_hub(edition) if loaded else None
