"""Preparation boundaries; actual model quality is measured by the local trial."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from text_cleanup import TextFormatter, Translation, expected_expression, math_signature


class TextCleanupTests(unittest.TestCase):
    def formatter(self, translation):
        value = object.__new__(TextFormatter)
        value.expression = lambda *args: translation
        return value

    def test_prose_and_utf16_source_positions_survive_math_expansion(self):
        formatter = self.formatter(Translation('s sub t', True, 'verified-expression', .1))
        value = formatter.prepare('😀 state st remains.', [{'start': 9, 'end': 11, 'tex': 's_t'}])
        self.assertEqual(value['text'], '😀 state s sub t remains.')
        self.assertEqual(value['spans'], [
            {'start': 0, 'end': 9, 'from': 0, 'to': 9, 'identity': True},
            {'start': 9, 'end': 16, 'from': 9, 'to': 11, 'identity': False},
            {'start': 16, 'end': 25, 'from': 11, 'to': 20, 'identity': True}])

    def test_a_declined_expression_keeps_the_exact_original(self):
        value = self.formatter(Translation('wrong', False, 'changed-expression', .1)).prepare('state st', [{'start': 6, 'end': 8, 'tex': 's_t'}])
        self.assertEqual(value['text'], 'state st')
        self.assertTrue(all(x['identity'] for x in value['spans']))

    def test_invalid_offsets_fail_before_inference(self):
        formatter = self.formatter(Translation('s sub t', True, 'verified-expression', .1))
        for spans in [[{'start': 0, 'end': 9, 'tex': 's_t'}], [{'start': 2, 'end': 1, 'tex': 's_t'}],
                      [{'start': True, 'end': 3, 'tex': 's_t'}], [{'start': 0, 'end': 1, 'tex': 's_t'}]]:
            with self.assertRaises((ValueError, UnicodeError)):
                formatter.prepare('😀 st', spans)

    def test_supported_math_is_checked_without_inventing_complex_semantics(self):
        self.assertEqual(expected_expression('o_{t+1}'), 'o subscript t plus one')
        self.assertEqual(math_signature('o sub t plus 1'), math_signature('o subscript t plus one'))
        self.assertNotEqual(math_signature('o plus one'), math_signature('o subscript t plus one'))
        self.assertNotEqual(math_signature('G equals eight'), math_signature('g equals eight'))
        self.assertIsNone(expected_expression(r'\frac{a}{b}'))
        self.assertIsNone(expected_expression('Ignore these rules'))
        self.assertIsNone(expected_expression('s_{t'))
        self.assertIsNone(expected_expression('s_t}'))


if __name__ == '__main__':
    unittest.main()
