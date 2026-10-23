"""Bounded official volleyball schedule in addition to existing NBA/football.

Endpoint/field provenance: Volleyball World's public global-schedule page and
global-schedule-v2-page.js, inspected 23 October 2026. Status 0 is upcoming;
1 is playing and 2 completed. World-ranking history is deliberately ignored.
"""
from datetime import date, datetime, timedelta, timezone
from .vendor.timing import OfficialKickoffs, _identity, _label, _provider_name, _provider_time, _source_id

VOLLEY_BASE = "https://en.volleyballworld.com/api/v1/globalschedule/"
COUNTRIES = {
    "france": "france", "roumanie": "romania", "argentine": "argentina",
    "bresil": "brazil", "allemagne": "germany", "pologne": "poland",
    "italie": "italy", "etats unis": "usa", "etats-unis": "usa",
    "japon": "japan", "slovenie": "slovenia", "turquie": "turkiye",
    "chine": "china", "serbie": "serbia", "canada": "canada",
    "pays-bas": "netherlands", "bulgarie": "bulgaria", "belgique": "belgium",
}


def volley_name(value):
    value = _label(value)
    return _identity(COUNTRIES.get(value, value))


def competition_key(value):
    value = _label(value)
    if value in {"vnl", "nations league", "ligue des nations", "volleyball nations league"}:
        return "vnl"
    if value.startswith("vnl ") and value[4:].isdigit():
        return "vnl"
    # No substring matching or unknown competition fallback. Clubs/genders
    # remain distinct unless the official names are exactly the same.
    return _identity(value)


class VerifiedKickoffs(OfficialKickoffs):
    def __call__(self, fixture, edition):
        if fixture.get("sport") != "volleyball":
            primary = super().__call__(fixture, edition)
            if primary is not None or fixture.get("sport") != "basketball" or _label(fixture.get("competition")) not in {"nba", "national basketball association"}:
                return primary
            return self._nba(fixture, date.fromisoformat(edition))
        target = date.fromisoformat(edition)
        gender = fixture.get("gender")
        if gender not in {"men", "women"}:
            return None
        wanted = [volley_name(fixture.get(side, "")) for side in ("home", "away")]
        if not all(wanted) or wanted[0] == wanted[1]:
            return None
        found = []
        for offset in (-1, 0, 1):
            day = (target + timedelta(days=offset)).isoformat()
            url = VOLLEY_BASE + day + "/" + day
            try:
                payload = self._load(url)
                teams = {str(row["no"]): row for row in payload["allTeams"]
                         if row.get("discipline") == "volley"}
                tournaments = {str(row["no"]): row for row in payload["allTournaments"]
                               if row.get("discipline") == "volley"}
                for row in payload["matches"]:
                    if (row.get("discipline") != "volley" or _label(row.get("gender")) != gender or type(row.get("matchStatus")) is not int or
                        row["matchStatus"] != 0 or row.get("isMatchTBD") is not False or
                        type(row.get("currentSetNo")) is not int or row["currentSetNo"] != 0 or row.get("teamAReplacementTBD") or row.get("teamBReplacementTBD")):
                        continue
                    participants = [teams.get(str(row.get(key)), {}) for key in ("teamANo", "teamBNo")]
                    if not all(participants) or not all(any(volley_name(team.get(field, "")) == name
                            for field in ("name", "translatedName", "code")) for team, name in zip(participants, wanted)):
                        continue
                    tournament = tournaments.get(str(row.get("tournamentNo")))
                    if not tournament or _label(tournament.get("gender")) != gender:
                        continue
                    names = [row.get(k, "") for k in ("competitionFullName", "competitionShortName")]
                    names += [tournament.get(k, "") for k in ("name", "competitionFullName", "competitionShortName")]
                    if competition_key(fixture.get("competition", "")) not in {competition_key(n) for n in names if n}:
                        continue
                    raw = row.get("matchDateUtc")
                    if not isinstance(raw, str) or not raw.endswith("Z"):
                        continue
                    instant = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                    if instant.date().isoformat() != day or type(row.get("matchNo")) is not int or row["matchNo"] <= 0 or type(row.get("tournamentNo")) is not int or row["tournamentNo"] <= 0:
                        continue
                    found.append({"kickoff_utc": instant.isoformat(), "source_url": url,
                        "source_id": str(row["matchNo"]), "method": "official_schedule",
                        "provider": "VolleyballWorld", "status": "upcoming", "time_valid": True,
                        "matched_participants": [fixture["home"], fixture["away"]],
                        "competition": fixture["competition"], "tournament_id": str(row["tournamentNo"]),
                        "gender": gender,
                        "orientation": "home_away"})
            except (OSError, ValueError, TypeError, AttributeError, KeyError):
                return None
        identities = {(p["source_id"], p["tournament_id"], p["kickoff_utc"]): p for p in found}
        return next(iter(identities.values())) if len(identities) == 1 else None

    def _nba(self, fixture, target):
        """A bounded ESPN fallback when NBA's public CDN is unavailable."""
        wanted = [_provider_name(fixture.get(side)) for side in ("home", "away")]
        found = []
        if not all(wanted) or wanted[0] == wanted[1]:
            return None
        try:
            for url, payload in self._provider_pages(["basketball/nba"], target):
                if not any(row.get("slug") == "nba" for row in payload.get("leagues", [])):
                    return None
                for event in payload["events"]:
                    for row in event.get("competitions", []):
                        moment = _provider_time(row, target)
                        identity = _source_id(row.get("id"))
                        sides = {p.get("homeAway"): p for p in row.get("competitors", []) if p.get("type") == "team"}
                        if not moment or not identity or set(sides) != {"home", "away"} or len(row.get("competitors", [])) != 2:
                            continue
                        if not all(wanted[i] in {_provider_name(sides[side].get("team", {}).get(k)) for k in ("displayName", "name", "shortDisplayName")}
                                for i, side in enumerate(("home", "away"))):
                            continue
                        found.append({"kickoff_utc": moment, "source_url": url, "source_id": identity,
                            "method": "provider_schedule", "provider": "ESPN", "league_id": "nba",
                            "time_valid": True, "status": "pre", "orientation": "home_away",
                            "matched_participants": [fixture["home"], fixture["away"]]})
        except (ValueError, OSError, TypeError, AttributeError, KeyError):
            return None
        return self._provider_unique(found)
