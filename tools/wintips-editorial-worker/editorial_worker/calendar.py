"""RDJ edition dates follow Paris; event instants remain explicitly UTC."""
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

EDITION_TIMEZONE = "Europe/Paris"


@lru_cache(maxsize=1)
def paris_timezone():
    try:
        return ZoneInfo(EDITION_TIMEZONE)
    except ZoneInfoNotFoundError:
        # Windows can lack the IANA database. This small, licensed TZif file is
        # only a fallback; Debian uses its maintained system zoneinfo database.
        filename = Path(__file__).resolve().parent / "assets/zoneinfo/Europe-Paris.tzif"
        with filename.open("rb") as handle:
            return ZoneInfo.from_file(handle, key=EDITION_TIMEZONE)


def edition_day(instant: datetime):
    if not isinstance(instant, datetime) or instant.tzinfo is None:
        raise ValueError("timezone_aware_clock_required")
    return instant.astimezone(paris_timezone()).date()


def source_event_day(instant: datetime):
    # Preserve the written date of a naive source clock for edition matching.
    # Event conversion is separate: an explicit offset has priority, otherwise
    # the approved RDJ editorial policy interprets the displayed time as UTC.
    return instant.date() if instant.tzinfo is None else edition_day(instant)
