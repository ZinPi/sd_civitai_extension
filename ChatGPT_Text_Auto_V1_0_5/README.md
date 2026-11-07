# ChatGPT Text Auto V1.1.6

Load unpacked thư mục này trên Chrome / Cốc Cốc (`chrome://extensions` → Developer mode). Sau khi cập nhật: bấm Reload trên `chrome://extensions`, rồi Ctrl+R tab ChatGPT.

Ba tab:
- **Văn bản lặp** — gửi payload dài nhiều lượt.
- **Tạo ảnh** — mỗi dòng (hoặc nhóm 1–10 dòng) một lần tạo ảnh trên ChatGPT.
- **Pilot tác phẩm** — pipeline chuyển tác phẩm (Nhật / Latinh / CHAR-BG / prompt ảnh hoặc video theo dòng). Cùng cơ chế background với hai tab kia: đóng panel không dừng chạy. Tích ô **Tạo prompt video theo dòng** thì bước tạo prompt đọc B8.TXT và QA `BUOC_QA_VIDEO_PROMPT_DAN_Y_CACH_VIET_SIMPLE.TXT` (ảnh vẫn dùng B5/B6). Ô **Yêu cầu thêm khi xuất file TXT** được gắn vào lệnh xuất TXT, nhất là bước chuyển đổi — xuất đầy đủ, không cắt vì văn bản dài.

Chrome / Cốc Cốc side panel:

- **Văn bản lặp** — gửi payload dài nhiều lượt trên tab ChatGPT đang mở.
- **Tạo ảnh** — mỗi dòng một prompt; khớp `CHAR_XX` / `BG_XX` với thư mục ảnh tham chiếu; bấm + → Tạo ảnh → gửi; tải ảnh về `ANH_1.png`, `ANH_2.png`, …

Xem `README_VI.txt`.
