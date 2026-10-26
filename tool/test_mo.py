import unittest

import mo


class MoTests(unittest.TestCase):
    def test_cong_chua_mo(self):
        self.assertFalse(mo.cong_dang_mo("127.0.0.1", 9))

    def test_may_chu_mo_roi_tat(self):
        server = mo.mo_may_chu("127.0.0.1", 18765)
        self.addCleanup(lambda: setattr(server, "should_exit", True))
        self.assertTrue(mo.doi_cong("127.0.0.1", 18765, giay=10))
        server.should_exit = True
