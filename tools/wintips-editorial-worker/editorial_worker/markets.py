"""Finite sports-market grammar. Unknown wording never becomes an LLM guess."""
from __future__ import annotations

import re
from .vendor.timing import _provider_name


class MarketError(ValueError):
    pass


def _participant(value, teams, sport):
    key = _provider_name(value, sport == "football")
    matches = [name for name in teams if key and _provider_name(name, sport == "football") == key]
    if len(matches) != 1:
        raise MarketError("market_participant_unverified")
    return matches[0]


def market(label, teams, sport):
    """Return canonical type and English, retaining every numerical threshold.

    The publisher owns the original label. Canonical output only describes that
    label; it does not select a market, price it, or infer overtime settlement.
    """
    label = re.sub(r"\s+", " ", label).strip().rstrip(".")
    units = {"buts": "goals", "but": "goals", "points": "points", "point": "points", "sets": "sets", "set": "sets"}
    m = re.fullmatch(r"Les (?:2|deux) [eé]quipes marquent(?:\s*[:—–-]\s*(Oui|Non))?", label, re.I)
    if m and sport == "football":
        return "btts", "Both teams to score — " + ("No" if (m[1] or "").lower() == "non" else "Yes")
    m = re.fullmatch(r"(Plus|Moins|\+|-)\s*(?:de\s+)?(\d+(?:[.,]\d+)?)\s+(buts?|points?|sets?)(?:\s+(?:dans le match|au total))?", label, re.I)
    if m:
        unit = units[m[3].lower()]
        allowed = {"football": {"goals"}, "basketball": {"points"}, "volleyball": {"sets", "points"}, "tennis": {"sets"}}
        if unit not in allowed.get(sport, set()):
            raise MarketError("market_unit_sport_conflict")
        kind = {"goals": "over_under_goals", "points": "total_points", "sets": "total_sets"}[unit]
        return kind, ("Over" if m[1].lower() in {"plus", "+"} else "Under") + " " + m[2].replace(",", ".") + " " + unit
    m = re.fullmatch(r"(Plus|Moins) de (\d+(?:[.,]\d+)?) (buts?|points?) (?:pour|de) (.+)", label, re.I)
    if m:
        actor = _participant(m[4], teams, sport)
        unit = units[m[3].lower()]
        if (sport, unit) not in {("football", "goals"), ("basketball", "points")}:
            raise MarketError("market_unit_sport_conflict")
        return ("team_goals" if unit == "goals" else "team_points"), actor + " " + ("over" if m[1].lower() == "plus" else "under") + " " + m[2].replace(",", ".") + " " + unit
    m = re.fullmatch(r"Victoire (?:de )?(.+?)\s+(\d+)[—–-](\d+)", label, re.I)
    if m and sport in {"volleyball", "tennis"}:
        actor = _participant(m[1], teams, sport)
        maximum = 3 if sport == "volleyball" else 3
        a, b = int(m[2]), int(m[3])
        if a not in {2, 3} or not 0 <= b < a or a > maximum:
            raise MarketError("set_score_invalid")
        if sport == "volleyball" and a != 3:
            raise MarketError("volleyball_set_score_invalid")
        return "exact_sets", f"{actor} to win {a}–{b}"
    m = re.fullmatch(r"Victoire (?:de )?(.+?) de (\d+) points? ou plus", label, re.I)
    if m and sport == "basketball":
        actor = _participant(m[1], teams, sport)
        return "winning_margin", actor + " to win by at least " + m[2] + " points"
    m = re.fullmatch(r"(.+?)\s+([+-]\d+(?:[.,]\d+)?)", label)
    if m and sport == "basketball":
        actor = _participant(m[1], teams, sport)
        return "points_handicap", actor + " " + m[2].replace(",", ".") + " points"
    m = re.fullmatch(r"(.+?) marque\s+(?:\+|plus)\s+de\s+(\d+(?:[.,]\d+)?)\s+(?:pts|points)", label, re.I)
    if m and sport == "basketball":
        # Exact source player name is retained, never expanded to an assumed
        # roster identity (e.g. Wemby is not silently renamed Wembanyama).
        if re.search(r"[;&+()]|\b(?:et|avec|ou)\b", m[1], re.I):
            raise MarketError("player_market_ambiguous")
        return "player_points", m[1] + " over " + m[2].replace(",", ".") + " points"
    m = re.fullmatch(r"(.+?)(?: marque)?\s+(\d+(?:[.,]\d+)?)\s*(?:pts|points)\s*(?:ou plus|ou\s*\+)", label, re.I)
    if m and sport == "basketball":
        if re.search(r"[;&+()]|\b(?:et|avec|ou|victoire)\b", m[1], re.I):
            raise MarketError("player_market_ambiguous")
        return "player_points", m[1] + " " + m[2].replace(",", ".") + "+ points"
    m = re.fullmatch(r"Victoire\s+(?:de\s+)?(.+)", label, re.I)
    if m:
        return "match_winner", _participant(m[1], teams, sport) + " to win"
    if re.fullmatch(r"Match nul", label, re.I) and sport == "football":
        return "draw", "Draw"
    raise MarketError("market_requires_explicit_adapter")


GOAL_TYPES = frozenset({"btts", "over_under_goals", "team_goals"})
