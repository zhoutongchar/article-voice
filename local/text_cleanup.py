"""Experimental, local HTML-to-speech preparation with source-span provenance.

Prose is copied exactly. A small LLM verbalizes explicitly identified HTML math,
and a restricted grammar checks its answer. Unsupported expressions stay intact.
This experiment is not enabled in the installed Chrome reader.
"""
import re
import time
from dataclasses import dataclass

MODEL = "mlx-community/Qwen3-0.6B-4bit"
REVISION = "73e3e38d981303bc594367cd910ea6eb48349da8"
POLICY = "html-math-preserve-prose-v1"
SYSTEM = (
    "Convert the supplied LaTeX expression into words for reading aloud. "
    "Say the letters, subscripts, superscripts, numbers, and operators. Preserve every part. "
    "Do not explain, solve, or add context. Return only the spoken expression. "
    "Examples: s_t -> s sub t; x^2 -> x squared; a_{t+1} -> a sub t plus one; "
    r"\mathcal M_t -> M sub t; G=8 -> G equals eight."
)
NUMBERS = dict(enumerate(("zero one two three four five six seven eight nine ten").split()))


def utf16_length(value):
    return len(value.encode("utf-16-le")) // 2


def source_slice(value, start, end):
    """Offsets on the wire belong to the browser, not Python code points."""
    encoded = value.encode("utf-16-le")
    return encoded[start * 2:end * 2].decode("utf-16-le")


def number(value):
    return NUMBERS.get(int(value), value)


def expected_expression(tex):
    """Only advertise expressions whose identity and operators can be checked.

    This intentionally does not guess how to interpret arbitrary LaTeX, prose
    inside math, fractions or long equations. Those need a richer math reader.
    """
    value = re.sub(r"\\mathcal\s*([A-Za-z])", r"\1", tex.strip())
    if "{" in value or "}" in value:
        grouped = re.fullmatch(r"([A-Za-z])([_^])\{([A-Za-z0-9](?:\+[0-9])?)\}", value)
        if not grouped:
            return None
        value = "".join(grouped.groups())
    if match := re.fullmatch(r"([A-Za-z])(?:_([A-Za-z0-9])(?:\+([0-9]))?|\^([23]))?", value):
        name, sub, plus, power = match.groups()
        if power:
            return f"{name} {'squared' if power == '2' else 'cubed'}"
        if sub:
            return f"{name} subscript {number(sub) if sub.isdigit() else sub}" + (f" plus {number(plus)}" if plus else "")
        return name
    if match := re.fullmatch(r"([A-Za-z])=([0-9])", value):
        return f"{match[1]} equals {number(match[2])}"
    return None


def math_signature(value):
    # Accept the two common spoken forms, but never drop a variable, operator,
    # digit or change its case. Case matters for mathematical identifiers.
    tokens = re.findall(r"[A-Za-z]+|[0-9]+|[^\w\s.,]", value)
    return ["subscript" if token == "sub" else number(token) if token.isdigit() else token for token in tokens]


@dataclass(frozen=True)
class Translation:
    text: str
    accepted: bool
    reason: str
    elapsed: float


class TextFormatter:
    def __init__(self, model_path):
        from mlx_lm import load
        self.model, self.tokenizer = load(str(model_path))
        self.cache = {}

    def expression(self, tex, cancelled=None):
        from mlx_lm import stream_generate
        from mlx_lm.sample_utils import make_sampler
        if cancelled and cancelled.is_set():
            raise InterruptedError("Preparation cancelled")
        if tex in self.cache:
            cached = self.cache[tex]
            return Translation(cached.text, cached.accepted, cached.reason, 0)
        expected = expected_expression(tex)
        if expected is None:
            return Translation("", False, "unsupported-expression", 0)
        prompt = self.tokenizer.apply_chat_template(
            [{"role": "system", "content": SYSTEM}, {"role": "user", "content": tex}],
            tokenize=False, add_generation_prompt=True, enable_thinking=False)
        started, chunks, finish = time.perf_counter(), [], None
        for part in stream_generate(self.model, self.tokenizer, prompt=prompt, max_tokens=64, sampler=make_sampler(temp=0)):
            if cancelled and cancelled.is_set():
                raise InterruptedError("Preparation cancelled")
            chunks.append(part.text); finish = part.finish_reason
            if time.perf_counter() - started > 5:
                return Translation("", False, "time-limit", time.perf_counter() - started)
        answer = "".join(chunks).strip()
        accepted = finish == "stop" and math_signature(answer) == math_signature(expected)
        result = Translation(answer, accepted, "verified-expression" if accepted else "changed-expression", time.perf_counter() - started)
        self.cache[tex] = result
        return result

    def prepare(self, text, expressions, cancelled=None):
        started = time.perf_counter()
        if not isinstance(text, str) or not text or utf16_length(text) > 2500 or not isinstance(expressions, list) or len(expressions) > 64:
            raise ValueError("Expected a short HTML passage and its math spans")
        # Validate the complete boundary before inference or partial output.
        previous = 0
        for item in expressions:
            start, end, tex = item.get("start"), item.get("end"), item.get("tex")
            if type(start) is not int or type(end) is not int or not previous <= start < end <= utf16_length(text) or not isinstance(tex, str) or len(tex) > 200:
                raise ValueError("Invalid HTML math span")
            source_slice(text, start, end)  # Reject a split surrogate pair.
            previous = end
        parts, spans, decisions, position, cursor = [], [], [], 0, 0

        def append(value, start, end, identity):
            nonlocal position
            if not value:
                return
            length = utf16_length(value)
            parts.append(value)
            spans.append({"start": position, "end": position + length, "from": start, "to": end, "identity": identity})
            position += length

        for item in expressions:
            start, end = item["start"], item["end"]
            append(source_slice(text, cursor, start), cursor, start, True)
            result = self.expression(item["tex"], cancelled)
            original = source_slice(text, start, end)
            append(result.text if result.accepted else original, start, end, not result.accepted)
            decisions.append({**item, "original": original, "candidate": result.text,
                              "accepted": result.accepted, "reason": result.reason, "elapsed": result.elapsed})
            cursor = end
        append(source_slice(text, cursor, utf16_length(text)), cursor, utf16_length(text), True)
        return {"original": text, "text": "".join(parts), "spans": spans, "decisions": decisions,
                "model": MODEL, "revision": REVISION, "policy": POLICY, "elapsed": time.perf_counter() - started}
