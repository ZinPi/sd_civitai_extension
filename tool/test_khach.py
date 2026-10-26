import unittest

from khach import KhachTrang


class KhachTests(unittest.TestCase):
    def test_chua_co_tab_thi_khong_tat(self):
        khach = KhachTrang(cho_roi=5, het_nhip=10)
        self.assertFalse(khach.nen_tat(10_000))
        khach.roi("tab-a", 1)
        self.assertFalse(khach.nen_tat(10_000))

    def test_roi_tab_roi_het_gio_cho_moi_tat(self):
        khach = KhachTrang(cho_roi=5, het_nhip=150)
        self.assertTrue(khach.nhip("tab-a", 0))
        khach.roi("tab-a", 10)
        self.assertFalse(khach.nen_tat(14.9))
        self.assertTrue(khach.nen_tat(15))

    def test_tai_lai_trang_thi_huy_lenh_tat(self):
        khach = KhachTrang(cho_roi=5, het_nhip=150)
        khach.nhip("tab-a", 0)
        khach.roi("tab-a", 10)
        self.assertTrue(khach.nhip("tab-b", 12))
        self.assertFalse(khach.nen_tat(30))

    def test_con_mot_tab_thi_khong_tat(self):
        khach = KhachTrang(cho_roi=5, het_nhip=150)
        khach.nhip("tab-a", 0)
        khach.nhip("tab-b", 1)
        khach.roi("tab-a", 2)
        self.assertFalse(khach.nen_tat(40))
        khach.roi("tab-b", 40)
        self.assertFalse(khach.nen_tat(44))
        self.assertTrue(khach.nen_tat(45))

    def test_mat_nhip_lau_thi_tat(self):
        khach = KhachTrang(cho_roi=5, het_nhip=10)
        khach.nhip("tab-a", 0)
        self.assertFalse(khach.nen_tat(9.9))
        self.assertFalse(khach.nen_tat(10))
        self.assertTrue(khach.nen_tat(15))

    def test_nhip_tre_khong_giu_tab_vua_dong(self):
        khach = KhachTrang(cho_roi=5, het_nhip=150)
        khach.nhip("tab-a", 0)
        khach.roi("tab-a", 10)
        self.assertTrue(khach.nhip("tab-a", 10.2))
        self.assertFalse(khach.nen_tat(14.9))
        self.assertTrue(khach.nen_tat(15))

    def test_mo_lai_cung_tab_sau_nhip_tre(self):
        khach = KhachTrang(cho_roi=5, het_nhip=150)
        khach.nhip("tab-a", 0)
        khach.roi("tab-a", 10)
        self.assertTrue(khach.nhip("tab-a", 11.1))
        self.assertFalse(khach.nen_tat(20))

    def test_tab_moi_van_huy_lenh_tat_ngay(self):
        khach = KhachTrang(cho_roi=5, het_nhip=150)
        khach.nhip("tab-a", 0)
        khach.roi("tab-a", 10)
        self.assertTrue(khach.nhip("tab-b", 10.2))
        self.assertFalse(khach.nen_tat(20))

    def test_ma_tab_sai_bi_bo(self):
        khach = KhachTrang(cho_roi=5, het_nhip=10)
        self.assertFalse(khach.nhip("", 0))
        self.assertFalse(khach.nhip("../x", 0))
        self.assertFalse(khach.nhip("co dau cach", 0))
        self.assertFalse(khach.nhip("a" * 65, 0))
        self.assertTrue(khach.nhip("a" * 64, 0))
        self.assertFalse(khach.nen_tat(1))


if __name__ == "__main__":
    unittest.main()
