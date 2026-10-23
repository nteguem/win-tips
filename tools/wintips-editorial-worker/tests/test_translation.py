from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from editorial_worker.translation import (LocalTranslator, TranslationConfig, TranslationRejected,
    CascadeTranslator, translate_batch, require_bilingual)


def response(text):
    return {"done": True, "done_reason": "stop", "message": {"content": text}}


def fixture():
    return {"source": "rdj_football_analysis", "editionDate": "2026-10-23", "items": [{
        "sourceId": "5802966", "title": {"fr": "Brest — Nice"}, "summary": {"fr": "Brest reste en forme."},
        "teams": {"home": {"name": "Brest"}, "away": {"name": "Nice"}},
        "startsAtUtc": "2026-10-23T18:45:00Z", "analysis": {"fr": [{"heading": "Analyse du match",
        "paragraphs": ["Brest a gagné trois matchs."]}]},
        "selection": {"label": {"fr": "Victoire Brest"}, "odds": 2.15}, "status": "upcoming"}]}


class TranslationTest(unittest.TestCase):
    def translator(self, results, **kwargs):
        calls = []
        def request(model, prompt, remaining):
            calls.append(model)
            if isinstance(results, dict):
                source = prompt.split("\n\n\n")[-1]
                return response(results[source])
            return response(results[len(calls) - 1])
        translator = LocalTranslator(TranslationConfig(**kwargs), request=request)
        return translator, calls

    def test_real_translation_preserves_french_structure_odds_names_and_time(self):
        original = fixture()
        snapshot = deepcopy(original)
        translator, calls = self.translator({"Brest reste en forme.": "Brest remains in good form.",
            "Brest a gagné trois matchs.": "Brest won three matches."})
        result, audit = translate_batch(original, translator)
        self.assertEqual(original, snapshot)
        self.assertEqual(result["items"][0]["title"]["en"], "Brest — Nice")
        self.assertEqual(result["items"][0]["selection"]["label"]["en"], "Brest to win")
        self.assertEqual(result["items"][0]["analysis"]["en"][0]["paragraphs"], ["Brest won three matches."])
        self.assertTrue(audit["frAndStructuralFactsPreserved"])
        self.assertEqual(len(calls), 2)

    def test_changed_quantity_fails_closed_both_attempts(self):
        translator, calls = self.translator(["Brest won four matches."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Brest a gagné trois matchs.", fixture()["items"][0])
        self.assertEqual(len(calls), 2)

    def test_qwen_receives_system_rules_and_original_french_as_user(self):
        captured = []
        class Reply:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, limit): return json.dumps(response("Brest won three matches.")).encode()
        class Opener:
            def open(self, request, timeout):
                captured.append(json.loads(request.data))
                return Reply()
        translator = LocalTranslator()
        with patch("editorial_worker.translation.build_opener", return_value=Opener()):
            translator._request("qwen2.5:7b-instruct-q4_K_M", "Translate faithfully.\n\n\nBrest a gagné trois matchs.", 30)
        self.assertEqual(captured[0]["messages"], [
            {"role": "system", "content": "Translate faithfully."},
            {"role": "user", "content": "Brest a gagné trois matchs."}])

    def test_last_four_is_not_last_sixteen(self):
        source = "L'an passé, Brest a atteint le dernier carré."
        translator, _ = self.translator(["Last year, Brest reached the last sixteen."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence(source, fixture()["items"][0])
        translator, _ = self.translator(["Last year, Brest reached the semi-finals."])
        self.assertEqual(translator.sentence(source, fixture()["items"][0]), "Last year, Brest reached the semi-finals.")

    def test_getting_better_of_opponent_preserves_winner_not_just_a_lead(self):
        source = "Brest a pris le dessus sur Nice (2-1)."
        for target in ("Brest beat Nice (2-1).", "Brest defeated Nice (2-1).", "Brest got the better of Nice (2-1)."):
            translator, _ = self.translator([target])
            self.assertEqual(translator.sentence(source, fixture()["items"][0]), target)
        for target in ("Brest took the lead over Nice (2-1).", "Brest led Nice (2-1).", "Nice beat Brest (2-1)."):
            translator, _ = self.translator([target] * 2)
            with self.assertRaises(TranslationRejected):
                translator.sentence(source, fixture()["items"][0])

    def test_result_idiom_in_forecast_preserves_uncertainty(self):
        source = "Brest pourrait prendre le dessus sur Nice."
        translator, _ = self.translator(["Brest could get the better of Nice."])
        self.assertEqual(translator.sentence(source, fixture()["items"][0]), "Brest could get the better of Nice.")
        translator, _ = self.translator(["Brest beat Nice."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence(source, fixture()["items"][0])

    def test_last_monday_does_not_become_monday_of_previous_week_on_friday(self):
        source = "Brest a gagné lundi dernier."
        for target in ("Brest won last Monday.", "Brest won on Monday."):
            translator, _ = self.translator([target])
            self.assertEqual(translator.sentence(source, fixture()["items"][0]), target)
        for target in ("Brest won on Monday last week.", "Brest won last week on Monday."):
            translator, _ = self.translator([target] * 2)
            with self.assertRaises(TranslationRejected):
                translator.sentence(source, fixture()["items"][0])

    def test_last_friday_and_friday_last_week_are_equivalent_on_friday(self):
        translator, _ = self.translator(["Brest won on Friday last week."])
        self.assertEqual(translator.sentence("Brest a gagné vendredi dernier.", fixture()["items"][0]), "Brest won on Friday last week.")

    def test_previous_week_equivalence_uses_source_paris_calendar(self):
        item = fixture()["items"][0]
        item["startsAtUtc"] = "2026-10-25T23:15:00Z"  # Monday in Paris.
        translator, _ = self.translator(["Brest won on Monday last week."])
        self.assertEqual(translator.sentence("Brest a gagné lundi dernier.", item), "Brest won on Monday last week.")

    def test_expected_relegation_battle_is_not_expected_safety(self):
        source = "Attendu dans la lutte pour ne pas descendre, le promu fait belle impression."
        translator, _ = self.translator(["Expected to avoid relegation, the promoted team has made a good impression."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence(source, fixture()["items"][0])
        translator, _ = self.translator(["Expected to be in the relegation battle, the promoted team has made a good impression."])
        self.assertEqual(translator.sentence(source, fixture()["items"][0]), "Expected to be in the relegation battle, the promoted team has made a good impression.")

    def test_changed_winner_fails(self):
        translator, _ = self.translator(["Nice beat Brest 2-1."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Brest a battu Nice 2-1.", fixture()["items"][0])

    def test_french_copy_is_rejected(self):
        source = "Brest reste en forme."
        translator, _ = self.translator([source] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence(source, fixture()["items"][0])

    def test_no_remote_or_credentialed_or_redirected_endpoint(self):
        for endpoint in ("https://example.com/api/", "http://user:pass@127.0.0.1/api/", "http://127.0.0.1/", "http://localhost/api/?key=secret"):
            with self.assertRaises(TranslationRejected):
                LocalTranslator(TranslationConfig(endpoint=endpoint))

    def test_missing_leg_english_is_rejected(self):
        translator, _ = self.translator({"Brest reste en forme.": "Brest remains in good form.",
            "Brest a gagné trois matchs.": "Brest won three matches."})
        result, _ = translate_batch(fixture(), translator)
        result["items"][0]["legs"] = [fixture()["items"][0]]
        with self.assertRaises(TranslationRejected):
            require_bilingual(result)

    def test_combination_legs_are_translated(self):
        payload = fixture()
        payload["items"][0]["legs"] = [deepcopy(payload["items"][0])]
        translator, _ = self.translator({"Brest reste en forme.": "Brest remains in good form.",
            "Brest a gagné trois matchs.": "Brest won three matches."})
        result, _ = translate_batch(payload, translator)
        self.assertTrue(require_bilingual(result))
        self.assertIn("en", result["items"][0]["legs"][0]["analysis"])

    def test_cached_response_revalidated_not_trusted(self):
        with tempfile.TemporaryDirectory() as directory:
            translator, calls = self.translator(["Brest won three matches."])
            translator.cache_dir = Path(directory)
            item = fixture()["items"][0]
            source = "Brest a gagné trois matchs."
            translator.sentence(source, item)
            translator.sentence(source, item)
            self.assertEqual(len(calls), 1)
            path = next(Path(directory).glob("*.json"))
            record = json.loads(path.read_text("utf-8"))
            record["response"] = response("Brest won four matches.")
            path.write_text(json.dumps(record), "utf-8")
            translator.request = lambda *args: response("Brest won three matches.")
            self.assertEqual(translator.sentence(source, item), "Brest won three matches.")

    def test_proper_accents_remain_exact(self):
        item = fixture()["items"][0]
        item["teams"]["home"]["name"] = "Fribourg"
        translator, _ = self.translator(["Freiburg won."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Fribourg a gagné.", item)

    def test_turf_compound_number_and_clock(self):
        translator, _ = self.translator(["Eighteen trotters will cover 2,850 metres at 8:15 pm."])
        self.assertEqual(translator.sentence("Dix-huit trotteurs parcourront 2 850 mètres à 20h15.", {}),
                         "Eighteen trotters will cover 2,850 metres at 8:15 pm.")

    def test_calendar_format_can_change_without_changing_date(self):
        translator, _ = self.translator(["The race is on Friday, October 23, 2026."])
        self.assertEqual(translator.sentence("La course est vendredi 23 octobre 2026.", {}),
                         "The race is on Friday, October 23, 2026.")

    def test_changed_calendar_date_is_rejected(self):
        translator, _ = self.translator(["The race is on Friday, October 24, 2026."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("La course est vendredi 23 octobre 2026.", {})

    def test_momentum_is_not_an_invented_winning_streak(self):
        translator, calls = self.translator([])
        self.assertEqual(translator.text("Brest sur sa lancée", fixture()["items"][0]), "Brest to maintain momentum")
        self.assertEqual(calls, [])

    def test_unknown_selection_is_rejected_before_model_request(self):
        translator, calls = self.translator([])
        with self.assertRaises(TranslationRejected):
            translator.market("Un pari spécial", fixture()["items"][0])
        self.assertEqual(calls, [])

    def test_unbeaten_is_not_necessarily_a_win(self):
        source = "Brest enchaîne un deuxième match sans défaite."
        translator, _ = self.translator(["Brest records a second unbeaten match."])
        self.assertEqual(translator.sentence(source, fixture()["items"][0]), "Brest records a second unbeaten match.")
        translator, _ = self.translator(["Brest records a second consecutive win."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence(source, fixture()["items"][0])

    def test_nice_nickname_is_restored_only_in_proved_nice_context(self):
        translator, _ = self.translator(["The Eagles won."])
        self.assertEqual(translator.sentence("Les Aiglons ont gagné.", fixture()["items"][0]), "The Aiglons won.")
        translator, _ = self.translator(["The Eagles won."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Les Aiglons ont gagné.", {})

    def test_midtable_is_not_bottom_of_the_table(self):
        translator, _ = self.translator(["Brest sits near the bottom of the table."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Brest est dans le ventre mou du classement.", fixture()["items"][0])

    def test_numerical_advantage_is_not_goal_advantage(self):
        translator, _ = self.translator(["Brest played with a one-goal advantage."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Brest a joué en supériorité numérique.", fixture()["items"][0])
        translator, _ = self.translator(["Brest played with numerical superiority."])
        self.assertEqual(translator.sentence("Brest a joué en supériorité numérique.", fixture()["items"][0]),
                         "Brest played with numerical superiority.")

    def test_football_matchdays_do_not_become_calendar_days(self):
        translator, _ = self.translator(["Brest is 10th after 7 days."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Brest est 10e après 7 journées.", fixture()["items"][0])

    def test_football_point_lead_can_use_english_compound_adjective(self):
        translator, _ = self.translator(["Brest has a three-point lead."])
        self.assertEqual(translator.sentence("Brest a trois longueurs d'avance.", fixture()["items"][0]),
                         "Brest has a three-point lead.")

    def test_an_impressive_result_does_not_invent_a_win(self):
        translator, _ = self.translator(["Brest achieved a major victory."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Brest a frappé un grand coup.", fixture()["items"][0])

    def test_french_aucune_ne_is_one_negative_proposition(self):
        translator, _ = self.translator(["No team wins."])
        self.assertEqual(translator.sentence("Aucune équipe ne gagne.", {}), "No team wins.")
        translator, _ = self.translator(["A team wins."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Aucune équipe ne gagne.", {})

    def test_mt_success_never_starts_the_large_model(self):
        starts, qwen = [], []
        translator = CascadeTranslator(mt_model="opus-test", mt_request=lambda *args: response("Brest won three matches."),
            ensure_fallback_ready=lambda: starts.append(True), request=lambda *args: qwen.append(True))
        self.assertEqual(translator.sentence("Brest a gagné trois matchs.", fixture()["items"][0]), "Brest won three matches.")
        self.assertEqual(starts, [])
        self.assertEqual(qwen, [])
        self.assertEqual(translator.records[-1]["engine"], "local_mt")

    def test_mt_guard_failure_uses_qwen_once_and_starts_only_once(self):
        starts, qwen = [], []
        def fallback(*args):
            qwen.append(True)
            return response("Brest won three matches.")
        translator = CascadeTranslator(mt_model="opus-test", mt_request=lambda *args: response("Brest won four matches."),
            ensure_fallback_ready=lambda: starts.append(True), request=fallback)
        for _ in range(2):
            self.assertEqual(translator.sentence("Brest a gagné trois matchs.", fixture()["items"][0]), "Brest won three matches.")
        self.assertEqual(len(starts), 1)
        self.assertEqual(len(qwen), 2)
        self.assertEqual(translator.config.fallback_model, "translategemma:4b")
        self.assertTrue(translator.records[-1]["cascadeFallbackUsed"])

    def test_cascade_does_not_hide_invalid_source_or_global_budget(self):
        starts = []
        translator = CascadeTranslator(TranslationConfig(max_segments=1), mt_model="opus-test",
            mt_request=lambda *args: response("Brest won three matches."),
            ensure_fallback_ready=lambda: starts.append(True))
        with self.assertRaises(TranslationRejected):
            translator.sentence("", fixture()["items"][0])
        self.assertEqual(starts, [])

    def test_cached_qwen_fallback_does_not_start_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            translator = CascadeTranslator(mt_model="opus-test", cache_dir=directory,
                mt_request=lambda *args: response("Brest won four matches."),
                request=lambda *args: response("Brest won three matches."))
            source, item = "Brest a gagné trois matchs.", fixture()["items"][0]
            translator.sentence(source, item)
            starts = []
            translator = CascadeTranslator(mt_model="opus-test", cache_dir=directory,
                mt_request=lambda *args: response("Brest won four matches."),
                ensure_fallback_ready=lambda: starts.append(True))
            self.assertEqual(translator.sentence(source, item), "Brest won three matches.")
            self.assertEqual(starts, [])

    def test_three_engines_release_previous_model_before_each_actual_switch(self):
        events = []
        def request(model, prompt, remaining):
            events.append(("request", model))
            return response("Brest won four matches." if model.startswith("qwen") else "Brest won three matches.")
        translator = CascadeTranslator(mt_model="opus-test",
            mt_request=lambda *args: response("Brest won five matches."), request=request,
            ensure_fallback_ready=lambda: events.append(("lease",)),
            release_model=lambda model, remaining: events.append(("release", model)))
        for _ in range(2):
            self.assertEqual(translator.sentence("Brest a gagné trois matchs.", fixture()["items"][0]), "Brest won three matches.")
        self.assertEqual(events, [("lease",), ("request", "qwen2.5:7b-instruct-q4_K_M"),
            ("release", "qwen2.5:7b-instruct-q4_K_M"), ("request", "translategemma:4b"),
            ("release", "translategemma:4b"), ("request", "qwen2.5:7b-instruct-q4_K_M"),
            ("release", "qwen2.5:7b-instruct-q4_K_M"), ("request", "translategemma:4b")])
        self.assertEqual(translator.records[-1]["acceptedModel"], "translategemma:4b")
        self.assertEqual(translator.records[-1]["engine"], "local_translategemma")
        self.assertEqual(len(translator.records[-1]["attempts"]), 2)

    def test_failed_release_never_loads_the_second_model(self):
        calls = []
        def fail_release(model, remaining):
            raise TranslationRejected("model_unload_not_confirmed")
        translator = CascadeTranslator(mt_model="opus-test",
            mt_request=lambda *args: response("Brest won five matches."),
            request=lambda model, *args: calls.append(model) or response("Brest won four matches."),
            release_model=fail_release)
        with self.assertRaises(TranslationRejected) as raised:
            translator.sentence("Brest a gagné trois matchs.", fixture()["items"][0])
        self.assertEqual(calls, ["qwen2.5:7b-instruct-q4_K_M"])
        self.assertEqual(raised.exception.audit["attempts"][-1]["error"], "model_unload_not_confirmed")

    def test_network_failure_does_not_start_a_content_fallback(self):
        calls = []
        def offline(model, *args):
            calls.append(model)
            raise OSError("offline")
        translator = CascadeTranslator(mt_model="opus-test",
            mt_request=lambda *args: response("Brest won five matches."), request=offline)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Brest a gagné trois matchs.", fixture()["items"][0])
        self.assertEqual(calls, ["qwen2.5:7b-instruct-q4_K_M"])

    def test_validated_third_engine_cache_does_not_load_or_release_a_second_model(self):
        with tempfile.TemporaryDirectory() as directory:
            config = TranslationConfig()
            # Seed an exact-model cache via real LocalTranslator behavior.
            cached = LocalTranslator(TranslationConfig(model="translategemma:4b", fallback_model=None),
                cache_dir=Path(directory) / "qwen", request=lambda *args: response("Brest won three matches."))
            cached.sentence("Brest a gagné trois matchs.", fixture()["items"][0])
            calls = []
            translator = CascadeTranslator(config, mt_model="opus-test", cache_dir=directory,
                mt_request=lambda *args: response("Brest won five matches."),
                request=lambda model, *args: calls.append(model) or response("Brest won four matches."),
                release_model=lambda *args: self.fail("cache must not trigger model release"))
            self.assertEqual(translator.sentence("Brest a gagné trois matchs.", fixture()["items"][0]), "Brest won three matches.")
            self.assertEqual(calls, [config.model])
            self.assertEqual(translator.records[-1]["acceptedModel"], "translategemma:4b")

    def test_unload_and_startup_costs_cannot_escape_global_deadline(self):
        translator = CascadeTranslator(mt_model="opus-test",
            mt_request=lambda *args: response("Brest won five matches."),
            request=lambda *args: self.fail("deadline exhausted before inference"),
            ensure_fallback_ready=lambda: None)
        translator.last_requested_model = "translategemma:4b"
        translator.release_model = lambda *args: None
        with patch("editorial_worker.translation.time.monotonic", side_effect=[0, 0, 0, 5]):
            with self.assertRaisesRegex(TranslationRejected, "translation_time_budget_exceeded"):
                translator.request("qwen2.5:7b-instruct-q4_K_M", "rules\n\n\nBrest.", 1)

    def test_club_formation_is_not_training(self):
        translator, _ = self.translator(["The Piedmont training needed time to get on the way."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("La formation piémontaise a eu besoin de temps pour se mettre en route.", fixture()["items"][0])

    def test_league_survival_is_not_continuation(self):
        translator, _ = self.translator(["Brest had to work to ensure its continuation."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Brest a dû s’employer pour assurer son maintien.", fixture()["items"][0])

    def test_turf_runners_are_not_reasons_and_race_is_not_test(self):
        item = {"sport": {"key": "horse_racing"}}
        translator, _ = self.translator(["With so many reasons, the test could be difficult."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Avec autant de partants, l’épreuve pourrait être difficile.", item)
        translator, _ = self.translator(["With so many runners, the race could be difficult."])
        self.assertEqual(translator.sentence("Avec autant de partants, l’épreuve pourrait être difficile.", item),
                         "With so many runners, the race could be difficult.")

    def test_first_four_is_not_fourth_or_first_five(self):
        source = "Brest a gagné les quatre premières journées."
        translator, _ = self.translator(["Brest won the first four matchdays."])
        self.assertEqual(translator.sentence(source, fixture()["items"][0]), "Brest won the first four matchdays.")
        translator, _ = self.translator(["Brest won the first five matchdays."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence(source, fixture()["items"][0])

    def test_restrictive_ne_que_preserves_only_and_one_season(self):
        source = "Brest n'a eu besoin que d'une saison."
        translator, _ = self.translator(["Brest needed only one season."])
        self.assertEqual(translator.sentence(source, fixture()["items"][0]), "Brest needed only one season.")
        for bad in ("Brest did not need one season.", "Brest needed two seasons."):
            translator, _ = self.translator([bad] * 2)
            with self.assertRaises(TranslationRejected):
                translator.sentence(source, fixture()["items"][0])

    def test_past_concession_is_not_counterfactual_if(self):
        source = "S'ils ont mené à Lyon, les Aiglons ont regoûté à la défaite."
        translator, _ = self.translator(["Although they led at Lyon, the Aiglons lost again."])
        self.assertEqual(translator.sentence(source, fixture()["items"][0]), "Although they led at Lyon, the Aiglons lost again.")
        translator, _ = self.translator(["If they had led at Lyon, the Aiglons lost again."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence(source, fixture()["items"][0])

    def test_year_old_is_same_age_as_years(self):
        translator, _ = self.translator(["The competitors are 7-year-old runners."])
        self.assertEqual(translator.sentence("Les concurrents ont 7 ans.", {"sport": {"key": "horse_racing"}}),
                         "The competitors are 7-year-old runners.")

    def test_race_unfolding_is_not_its_result(self):
        source = "Le déroulement de l’épreuve pourrait peser lourd."
        item = {"sport": {"key": "horse_racing"}}
        translator, _ = self.translator(["The outcome of the race could weigh heavily."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence(source, item)
        translator, _ = self.translator(["How the race unfolds could have a major impact."])
        self.assertEqual(translator.sentence(source, item), "How the race unfolds could have a major impact.")

    def test_promotion_and_previous_season_are_not_rise_and_exercise(self):
        source = "Brest a rebondi en accrochant la montée lors du précédent exercice."
        translator, _ = self.translator(["Brest rebounded by hanging the rise during the previous exercise."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence(source, fixture()["items"][0])
        translator, _ = self.translator(["Brest bounced back by securing promotion last season."])
        self.assertEqual(translator.sentence(source, fixture()["items"][0]), "Brest bounced back by securing promotion last season.")

    def test_home_games_are_not_receptions(self):
        translator, _ = self.translator(["Brest lost their first receptions."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Brest a perdu ses premières réceptions.", fixture()["items"][0])

    def test_sole_win_is_not_a_distinctive_unique_success(self):
        source = "Brest a célébré son unique succès."
        translator, _ = self.translator(["Brest celebrated its unique success."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence(source, fixture()["items"][0])
        translator, _ = self.translator(["Brest celebrated its only win."])
        self.assertEqual(translator.sentence(source, fixture()["items"][0]), "Brest celebrated its only win.")

    def test_sports_form_is_not_geometrical_shape(self):
        translator, _ = self.translator(["Advantage Brest over shape."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.sentence("Avantage Brest sur la forme", fixture()["items"][0])

    def test_accumulator_market_preserves_names_and_leg_order(self):
        item = {"kind": "combine", "legs": [fixture()["items"][0], fixture()["items"][0]]}
        translator, calls = self.translator([])
        self.assertEqual(translator.market("Les deux équipes marquent Brest — Nice + Torino — Monza", item),
                         "Both teams to score — Brest — Nice + Torino — Monza")
        self.assertEqual(calls, [])

    def test_unsupported_selection_does_not_copy_french(self):
        translator, _ = self.translator(["Un pari spécial."] * 2)
        with self.assertRaises(TranslationRejected):
            translator.text("Un pari spécial.", {})

    def test_empty_summary_is_complete(self):
        payload = fixture()
        payload["items"][0]["summary"]["fr"] = ""
        translator, _ = self.translator(["Brest won three matches."])
        result, _ = translate_batch(payload, translator)
        self.assertEqual(result["items"][0]["summary"]["en"], "")

    def test_budget_fails_without_additional_model_call(self):
        translator, calls = self.translator(["Brest remains in good form."], max_segments=1)
        translator.sentence("Brest reste en forme.", fixture()["items"][0])
        with self.assertRaises(TranslationRejected):
            translator.sentence("Brest reste en forme.", fixture()["items"][0])
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
