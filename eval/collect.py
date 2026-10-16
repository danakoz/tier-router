"""Ask tev1 about every eval prompt once and cache its raw answers.

The cache is keyed by the exact state sent, so changing the questions or the
trimming re-asks only what changed."""
import hashlib, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tev1_router.classify import QUESTIONS, ask_tev1, state_for

HERE = Path(__file__).resolve().parent


def load_cases():
    # real.jsonl holds prompts from the author's own sessions and is not
    # published; the evaluation runs on the rest without it.
    real = HERE / "real.jsonl"
    cases = [json.loads(l) for l in open(real)] if real.exists() else []
    for line in open(HERE / "synthetic.tsv"):
        label, prompt = line.rstrip("\n").split("\t", 1)
        cases.append({"prompt": prompt, "context": "", "label": label, "source": "synthetic"})
    return cases


def load_blind():
    """Written after the first round of tuning and never fitted on."""
    cases = []
    for line in open(HERE / "blind.tsv"):
        label, prompt = line.rstrip("\n").split("\t", 1)
        cases.append({"prompt": prompt, "context": "", "label": label, "source": "blind"})
    return cases


def key(c):
    raw = json.dumps([QUESTIONS, state_for(c["prompt"], c.get("context", ""))], sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def main():
    cache_path = HERE / "cache.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    cases = load_cases() + load_blind()
    asked = 0
    for c in cases:
        k = key(c)
        if k not in cache:
            cache[k] = ask_tev1(c["prompt"], c.get("context", ""), timeout=120)
            asked += 1
    cache_path.write_text(json.dumps(cache))
    print(f"{len(cases)} cases, {asked} asked, {len(cache)} cached")


if __name__ == "__main__":
    main()
