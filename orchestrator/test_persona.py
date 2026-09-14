"""
Tests for persona.py's apply_persona_pass() -- both safety nets are pure
regex logic with no network/LLM/event-loop involved, so (unlike most of
this project) these are genuinely, fully testable rather than "logically
checked, not confirmed." No test file existed for the original dash
safety net before this one; added here as real regression coverage
alongside the new you're/You're one, rather than leaving both to ad hoc
sandbox checks only.
"""

from persona import apply_persona_pass


def test_dash_replaced_with_comma():
    assert apply_persona_pass("wait - actually never mind") == "wait, actually never mind"


def test_compound_word_dash_replaced():
    assert apply_persona_pass("your well-being matters") == "your well, being matters"


def test_em_dash_and_en_dash_both_replaced():
    assert apply_persona_pass("fine\u2014whatever") == "fine, whatever"
    assert apply_persona_pass("fine\u2013whatever") == "fine, whatever"


def test_no_dash_is_unchanged():
    assert apply_persona_pass("nothing to change here.") == "nothing to change here."


def test_youre_lowercase_replaced():
    assert apply_persona_pass("you're being annoying") == "you are being annoying"


def test_youre_capitalized_replaced_keeping_capitalization():
    assert apply_persona_pass("You're being annoying") == "You are being annoying"


def test_youre_does_not_touch_other_contractions():
    # Only "you're" was flagged as mispronounced -- everything else
    # should pass through untouched (see persona.py's own comment on
    # _YOURE_PATTERN for why this one word specifically).
    text = "I can't believe you're not done, don't worry though"
    assert apply_persona_pass(text) == "I can't believe you are not done, don't worry though"


def test_youre_and_dash_both_apply_in_one_pass():
    assert apply_persona_pass("you're right - I checked") == "you are right, I checked"
