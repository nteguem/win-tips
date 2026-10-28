"""Author only short coupon captions; never import articles or send a push."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
from zoneinfo import ZoneInfo

from editorial_worker.content_hub import module
from editorial_worker.gemini_translation import create_translator_from_env
from editorial_worker import gemini_translation as gemini
from editorial_worker.runner import build_coupon_teaser


def run(input_file, output_file):
    source = Path(input_file)
    if source.is_symlink() or source.stat().st_size > 8_000_000:
        raise ValueError('invalid_input_file')
    document = json.loads(source.read_text('utf-8'))
    today = datetime.now(ZoneInfo('Europe/Paris')).date().isoformat()
    if document.get('date') != today or not isinstance(document.get('batches'), list) or len(document['batches']) > 6:
        raise ValueError('invalid_current_edition')
    package = module()
    if package is None:
        raise ValueError('content_hub_unavailable')
    from rdj_hub import coupon_teaser as author
    translator = create_translator_from_env(cache_dir=Path(os.environ.get('RDJ_CONTENT_HUB_DIR', '/var/lib/rdj-content-hub')) / 'translations',
        max_seconds=max(30, len(document['batches']) * 17))
    result = {'date': today, 'teasers': []}
    audit = {'date': today, 'notificationsSent': 0, 'sourceItemsImported': 0, 'captions': []}
    seen = set()
    for batch in document['batches']:
        if batch.get('editionDate') != today or batch.get('source') in seen:
            raise ValueError('invalid_source_edition')
        seen.add(batch['source'])
        value = build_coupon_teaser(batch, translator)
        facts = author._facts(author.facts_from_wintips(batch))
        author.validate_teaser(facts, value)
        # Verify provenance using the independently cached native model result.
        # Do not expose raw responses, prompts, credentials or source analyses.
        texts = [author._bytes(author._prompt_facts(facts)).decode('utf-8')]
        identity = {'purpose': author.VERSION, 'facts': facts, 'model': translator.config.model,
            'instructions': author.INSTRUCTIONS, 'request': author.request_payload(translator.config, texts, provider=gemini)}
        saved = package.open_hub(today).read(author.NAMESPACE, author.digest(identity), ttl=3600, immutable=True)
        native = bool(saved and 'native' in saved and saved.get('teaser') == value
            and author._native_value(gemini, facts, saved['native']) == value)
        result['teasers'].append({'source': batch['source'], 'editionDate': today, 'couponTeaser': value})
        audit['captions'].append({'source': batch['source'], 'generatedBy': 'gemini' if native else 'metadata_fallback',
            'body': value['body'], 'characters': {lang: len(value['body'][lang]) for lang in ('fr', 'en')}})
    destination = Path(output_file)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    print(json.dumps(audit, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    arguments = parser.parse_args()
    try:
        run(arguments.input, arguments.output)
    except Exception as error:
        raise SystemExit('COUPON_TEASER_GENERATION_FAILED:' + type(error).__name__) from None
