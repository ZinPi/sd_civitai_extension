/* Exact texts from the user's square-bracket blocks. Do not rewrite the bodies. */
(function (root) {
  const JP_CRITERIA = `bản chuyển đổi phải đáp ứng PASS TOÀN BỘ CÁC TIÊU CHÍ SAU:

Một người kể: PASS
Kể liền mạch khi nghe: PASS
Thoại gián tiếp là chính: PASS
Không biến thành thống kê tình tiết: PASS
Không có cảm giác tóm tắt khô: PASS
Cấu trúc câu tự nhiên: PASS
Không có câu văn vụng/gượng đáng kể: PASS
Không còn kiểu câu cực ngắn để tạo nhịp: PASS
Không lặp nội dung:PASS
Không lặp ý: PASS
Không còn chuỗi câu vụn A。B。C。: PASS
Câu có đủ chủ thể/ngữ nghĩa để nghe một lần hiểu được: PASS
Không kéo câu quá dài đến mức khó nghe: PASS
Nhịp câu dài–vừa được thay đổi tự nhiên: PASS
Light novel Nhật: PASS
Fantasy/Isekai LN feeling: PASS(nếu có)
Gap comedy: PASS(nếu có)
Gap ecchi giữ tối đa các tình tiết 18+ không mô tả bộ phận phần than dưới : PASS(nếu có)
Reaction/emotional beat: PASS(nếu có)
Setup → payoff: PASS(nếu có)
強くなれ có biến đổi ý nghĩa và payoff: PASS(nếu có)
Climax không bị tách thành khối giải thích lore: PASS(nếu có)
Reveal quá khứ được đan vào hành động: PASS(nếu có)
False death → resurrection có setup và logic: PASS(nếu có)
Kết thúc quay lại motif cô độc/bữa ăn/căn nhà: PASS(nếu có)
Có dư âm sau kết: PASS(nếu có)

Quan trọng nhất: khôngdựa vào thủ pháp câu cực ngắn kiểu トモだった。, 痛い。, 今は違う。, 平和になった。 để giả tạo nhịp light novel nữa. Những điểm nhấn đã được chuyển thành câu hoàn chỉnh, vẫn có nhịp nhưng phù hợp audio một người kể. :PASS`;

  const JP_CRITERIA_QA = JP_CRITERIA.replace(
    "Quan trọng nhất: khôngdựa vào",
    "Quan trọng nhất: không dựa vào"
  );

  function sceneAwareBlock(percent) {
    return `CÔ ĐỌNG NỘI DUNG TÁC PHẨM CÒN ${percent}% NỘI DUNG GỐC THEO QUY TẮC NGUỒN DỰ ÁN

MỤC TIÊU CÔ ĐỌNG ${percent}% — SCENE-AWARE:
Cô đọng theo từng phân cảnh dựa trên tầm quan trọng đối với cốt truyện, cảm xúc, setup–payoff, reveal, comedy và progression. Không chia quota ký tự cứng cho từng cảnh hoặc batch. Sau khi hợp nhất toàn bộ tác phẩm, dùng tỷ lệ ký tự chỉ như phép kiểm tra cuối để phát hiện nén quá mức hoặc quá ít. Nếu lệch xa mục tiêu ${percent}%, phải chỉnh lại chính các phân cảnh có mức nén không hợp lý, không được chèn filler hoặc cắt máy móc để đạt số.`;
  }

  const LAT_CRITERIA = `**Một người kể: PASS**

**Kể liền mạch khi nghe: PASS**

**Thoại gián tiếp là chính: PASS**

**Không biến thành thống kê tình tiết: PASS**

**Không có cảm giác tóm tắt khô: PASS**

**Cấu trúc câu tiếng Tây Ban Nha Mỹ Latinh tự nhiên: PASS**

**Cách dùng từ và diễn đạt phù hợp người nghe Mỹ Latinh: PASS**

**Không có câu văn dịch máy, vụng hoặc gượng đáng kể: PASS**

**Không còn kiểu câu cực ngắn chỉ để tạo nhịp giả: PASS**

**Không lặp nội dung: PASS**

**Không lặp ý: PASS**

**Không còn chuỗi câu vụn A. B. C. liên tiếp: PASS**

**Không kéo câu quá dài đến mức khó nghe: PASS**

**Nhịp câu dài–vừa được thay đổi tự nhiên: PASS**

**Giữ được cảm giác light novel khi chuyển sang tiếng Tây Ban Nha Mỹ Latinh: PASS**

**Fantasy/Isekai LN feeling: PASS (nếu có)**

**Gap comedy: PASS (nếu có)**

**Gap ecchi 18+: PASS (nếu có)**

**Reaction/emotional beat: PASS (nếu có)**

**Setup → payoff: PASS (nếu có)**

**Motif/câu khóa kiểu «Hazte más fuerte» / «Vuélvete más fuerte» có biến đổi ý nghĩa và payoff: PASS (nếu có)**

**Climax không bị tách thành một khối giải thích lore khô cứng: PASS (nếu có)**

**Reveal quá khứ được đan tự nhiên vào hành động và diễn biến hiện tại: PASS (nếu có)**

**False death → resurrection có setup và logic: PASS (nếu có)**

**Kết thúc quay lại motif cô độc/bữa ăn/căn nhà: PASS (nếu có)**

**Có dư âm sau kết: PASS (nếu có)**

**Quan trọng nhất: không dựa vào thủ pháp những câu tiếng Tây Ban Nha cực ngắn kiểu «Era su amigo.», «Duele.», «Ahora es diferente.», «Llegó la paz.» chỉ để giả tạo nhịp light novel. Những điểm nhấn phải được chuyển thành câu hoàn chỉnh, có đủ ngữ nghĩa và liên kết với câu trước/sau, vẫn giữ được nhịp cảm xúc nhưng phải tự nhiên khi nghe bằng tiếng Tây Ban Nha Mỹ Latinh và phù hợp audio một người kể: PASS**`;

  const REF_PREP = `ĐÂY LÀ TÀI LIỆU CỦA PHẦN LIỀN TRƯỚC CỦA TÁC PHẨM, PHÂN TÍCH FILE NÀY THAM KHẢO NHÂN VẬT, BỐI CẢNH, SINH VẬT, DỤNG CỤ, VŨ KHÍ TRONG FILE, THAM KHẢO CHAR_XX VÀ BG_XX, KHI ĐẾN PHẦN TRÍCH XUẤT ẢNH THAM CHIẾU CỦA PHẦN TÁC PHẢM HIỆN TẠI THÌ KHI TRÍCH XUẤT ĐƯỢC NHÂN VẬT, BỐI CẢNH, SINH VẬT, DỤNG CỤ, VẬT PHẨM, VŨ KHÍ MỚI THÌ TÍCH HỢP NỐI TIẾP VÀO DANH SÁCH CỦA FILE TÀI LIỆU NGƯỜI DÙNG CUNG CẤP. CUỐI PHẦN TRẢ LỜI PHẢI VIẾT 1 CÂU"ĐÃ CẬP NHẬT ĐẦY ĐỦ DỮ LIỆU THAM KHẢO"`;

  const JP_LINE_SPLIT = `CHIA TÁC PHẨM VỪA CÔ ĐỘNG BÁO ĐẠT XONG THÀNH  DÒNG, MỖI DÒNG TỪ 48~76 ÂM TIẾT, GIỚI HẠN TỐI THIỂU 48 ÂM TIẾT, ƯU TIÊN NGẮT NGHĨ TRÙNG DẤU CÓ SẴN TRONG TÁC PHẨM CỦA CÂU. BÁO CÁO CUỐI CÂU TRẢ LỜI "ĐÃ CHIA XONG"`;

  const PROMPTS = {
    refPrep: REF_PREP,
    sourceAnalysis: `Đọc và hiểu 100% phạm vi nguồn trước khi bắt đầu chuyển đổi.

Phân tích và khóa:
- canon;
- thứ tự sự kiện;
- POV;
- nhân vật và quan hệ;
- mục tiêu và xung đột;
- trạng thái nhân vật;
- vật phẩm, năng lực và thông tin hệ thống;
- reveal và thời điểm reveal;
- setup → payoff;
- reaction/emotional beat;
- motif;
- progression;
- climax;
- các tuyến truyện song song;
- kết thúc và dư âm nếu có.

Sau khi phân tích toàn bộ nguồn, tự quyết định tác phẩm cần chia thành bao nhiêu BATCH ADAPTATION.

SỐ BATCH KHÔNG ĐƯỢC CỐ ĐỊNH TRƯỚC.

Phải quyết định số batch dựa trên:
- độ dài tác phẩm;
- cấu trúc cảnh;
- arc;
- mật độ tình tiết;
- số tuyến nhân vật;
- setup/payoff;
- reveal;
- climax;
- giới hạn xử lý an toàn.

Chia tại ranh giới chương/cụm cảnh hợp lý.

KHÔNG chia máy móc theo số chương bằng nhau.
KHÔNG cắt ngang climax, reveal, trận chiến, emotional beat hoặc setup → payoff nếu việc chia làm mất mạch.

Tạo dữ liệu continuity ngắn gọn cần truyền cho từng batch tiếp theo.`,

    batchAdapt: (ctx) => {
      const percent = Number(ctx?.condensePercent) || 40;
      const total = Number(ctx?.adaptBatchTotal) || 0;
      const index = (Number(ctx?.adaptBatchDone) || 0) + 1;
      const shown = total || "?";
      return `LẦN NÀY CHỈ CHUYỂN ĐỔI ĐÚNG BATCH ${index}/${shown} THEO DANH SÁCH ĐÃ CHIA Ở FULL SOURCE ANALYSIS. CẤM CHUYỂN BATCH KHÁC TRONG CÙNG MỘT LẦN TRẢ LỜI.

Thực hiện chuyển đổi lần lược Mỗi batch theo danh sách batch đã chia, phải được chuyển trực tiếp từ nguồn thành lời kể audio tiếng Nhật tự nhiên.

${sceneAwareBlock(percent)}

${JP_CRITERIA}

Yêu cầu:
- loại bỏ số tập;
- một narrator duy nhất;
- thoại gián tiếp là chính;
- không còn chuỗi câu vụn A。B。C。;
- không có câu văn vụng/gượng đáng kể;
- không trình bày kiểu kịch bản;
- không biến thành synopsis;
- không biến thành thống kê tình tiết;
- không tạo cảm giác tóm tắt khô;
- giữ tình huống → hành động/đối đáp → phản ứng → thay đổi/kết quả;
- giữ canon;
- giữ POV;
- giữ đúng người nói/người hành động;
- giữ reaction;
- giữ setup/payoff;
- giữ reveal timing;
- giữ progression;
- giữ DNA Light Novel Nhật;
- giữ fantasy/isekai/comedy/ecchi và các yếu tố thể loại nếu thực sự có trong nguồn.
- khôngdựa vào thủ pháp câu cực ngắn kiểu トモだった。, 痛い。, 今は違う。, 平和になった。 để giả tạo nhịp light novel nữa. Những điểm nhấn đã được chuyển thành câu hoàn chỉnh, vẫn có nhịp nhưng phù hợp audio một người kể.

Batch sau bắt buộc kế thừa continuity đã khóa từ các batch trước.

KHÔNG xem mỗi batch là một tác phẩm độc lập.`;
    },

    continuityMerge: `Sau khi hoàn thành tất cả batch, hợp nhất thành MỘT bản audio duy nhất.

Bắt buộc:
- bỏ ranh giới batch khỏi nội dung cuối;
- không ghi Batch 1, Batch 2...;
- không ghi số tập;
- không ghi số chương nếu người dùng yêu cầu audio liền mạch;
- nối cảnh tự nhiên;
- sửa các điểm chuyển batch bị gãy;
- thống nhất narrator;
- thống nhất cách gọi nhân vật và thuật ngữ;
- thống nhất trạng thái nhân vật;
- thống nhất giọng kể và nhịp văn;
- loại bỏ nội dung trùng;
- loại bỏ ý trùng;
- không làm mất setup/payoff trong quá trình ghép.

Bản sau khi merge phải nghe như được viết liền từ đầu đến cuối, không được có cảm giác ghép nhiều đoạn riêng.`,

    globalBalance: (percent) =>
      `${sceneAwareBlock(percent)}

Đọc lại toàn bộ bản đã merge và cân chỉnh mức cô đọng ở cấp TOÀN TÁC PHẨM về khoảng ${percent}% theo yêu cầu người dùng.

${percent}% là MỤC TIÊU MẬT ĐỘ KỂ CHUYỆN TOÀN CỤC.

KHÔNG hiểu máy móc là:
- ${percent}% số ký tự;
- ${percent}% số câu;
- ${percent}% số chương;
- ${percent}% từng cảnh;
- ${percent}% từng batch.

Ưu tiên cắt/nén:
- mô tả lặp;
- di chuyển ít giá trị;
- giải thích đã rõ;
- câu đệm;
- thông tin trùng;
- phản ứng lặp không có chức năng.

Ưu tiên giữ:
- nguyên nhân → kết quả;
- conflict;
- reaction;
- relationship progression;
- setup → payoff;
- reveal;
- climax;
- comedy timing;
- emotional beat;
- worldbuilding cần cho việc hiểu truyện;
- các chi tiết cần cho phần sau.

Nếu việc ép gần ${percent}% làm tác phẩm trở thành synopsis khô hoặc phá continuity thì ưu tiên bảo toàn chất lượng kể chuyện.`,

    finalJpQa: `Chỉ QA sau khi đã hoàn thành merge và global balance.

QA trực tiếp trên văn bản cuối, không mặc định PASS.

Bắt buộc kiểm tra toàn bộ 27 tiêu chí của quy trình nguồn.

Đặc biệt phải đảm bảo:
- Một người kể: PASS
- Kể liền mạch khi nghe: PASS
- Thoại gián tiếp là chính: PASS
- Không biến thành thống kê tình tiết: PASS
- Không có cảm giác tóm tắt khô: PASS
- Cấu trúc câu tự nhiên: PASS
- Không có câu văn vụng/gượng đáng kể: PASS
- Không còn kiểu câu cực ngắn để tạo nhịp: PASS
- Không lặp nội dung: PASS
- Không lặp ý: PASS
- Không còn chuỗi câu vụn A。B。C。: PASS
- Câu đủ chủ thể/ngữ nghĩa để nghe một lần hiểu: PASS
- Không kéo câu quá dài đến mức khó nghe: PASS
- Nhịp câu dài–vừa thay đổi tự nhiên: PASS
- Light Novel Nhật: PASS

Các tiêu chí thể loại/tình tiết chỉ PASS khi thực sự có trong nguồn; nếu nguyên tác không có thì đánh N/A, tuyệt đối không tự thêm tình tiết để ép PASS.

Nếu phát hiện lỗi:
ĐỐI CHIẾU LẠI NGUỒN
→ SỬA ĐÚNG ĐOẠN LỖI
→ KIỂM TRA LẠI ĐOẠN BỊ ẢNH HƯỞNG
→ RE-QA.

Chỉ được coi là hoàn thành khi toàn bộ tiêu chí bắt buộc và toàn bộ tiêu chí áp dụng thực tế đều PASS.

YÊU CẦU ĐẦU RA CUỐI:

Chỉ tạo MỘT tác phẩm audio tiếng Nhật liền mạch.

Không để lại:
- số batch;
- dấu phân chia xử lý nội bộ;
- báo cáo phân tích trong thân tác phẩm;
- log kỹ thuật;
- số tập/số chương nếu yêu cầu bản liền mạch.

Không được dùng chuỗi câu cực ngắn kiểu:
トモだった。
痛い。
今は違う。
平和になった。

để giả tạo nhịp Light Novel.

Các điểm nhấn phải được viết thành câu hoàn chỉnh, tự nhiên khi nghe bằng audio một người kể.`,

    latConvert: ` CHUYỂN ĐỔI TÁC PHẨM AUDIO TIẾNG NHẬT VỪA QA ĐẠT THÀNH TIẾNG MỸ LATINH KHÔNG TOM TẮT THEO QUY TẮC NGUỒN CỦA DỰ ÁN, ĐẢM BẢO ĐẠT CÁC TIÊU CHUẨN SAU:

${LAT_CRITERIA}`,

    latQa: `QA BẢN CHUUYỂN ĐỔI ĐẢM BẢO ĐẠT CÁC TIÊU CHUẨN SAU:

${LAT_CRITERIA}

QA KHÔNG TỰ Ý SỬA TÁC PHẨM  KHI CHƯA CÓ SỰ CHO PHÉP.
CUỐI CÂU TRẢ LỜI QUÁ TRÌNH QA PHẢI CHI 1 TRONG 2 CÂU TRONG NGOẶC KHÉP "BẢN CHUYỂN ĐỔI ĐẠT RỒI THỰC HIỆN BƯỚC TIẾP THEO" HOẶC "BẢN CHUYỂN ĐỔI CHƯA ĐẠT CẦN SỬA LẠI"`,

    latFix: `SỬA LẠI BẢN CHUYỂN ĐỔI MỸ LATINH CHO ĐẠT TIÊU CHUẨN CỦA QA`,

    lineSplit: `chia dòng tác phẩm chuyển đổi thành mỹ latinh vừa QA thành công, mỗi dòng từ 48~72 âm tiết, tối thiểu 46 âm tiết, uu tiên ngắt nghĩ theo dấu của văn bản tác phẩm góc, ko tự sáng tạo, bổ sung rút ngắn tác phẩm hay tự them hay bỏ dấu tác phẩm. tuyệt đối không chỉnh sửa nội dung tác phẩm góc.`,

    jpLineSplit: JP_LINE_SPLIT,

    chunkPlan: `YÊU CẦU PHÂN TÍCH CHIA TÁC PHẨM ĐÃ CHIA DÒNG THEO ÂM TIẾT THÀNH CÁC CHUNK.

ĐỌC ĐÚNG BẢN VỪA CHIA DÒNG THEO ÂM TIẾT. CHIA THÀNH ĐÚNG 4 CHUNK LIỀN NHAU, KHÔNG CHỒNG DÒNG, PHỦ HẾT TỪ DÒNG ĐẦU ĐẾN DÒNG CUỐI.

IN ĐÚNG 4 DÒNG PHẠM VI:
CHUNK 1: DÒNG A–B
CHUNK 2: DÒNG C–D
CHUNK 3: DÒNG E–F
CHUNK 4: DÒNG G–H

LẦN NÀY CHỈ CHIA PHẠM VI. CẤM TRÍCH XUẤT ẢNH. CẤM GỘP DANH SÁCH. CẤM TÍNH CAC_CAU, SO_CAU, NGƯỠNG. CẤM VERIFY. CẤM XUẤT B3 FINAL.`,

    chunkExtract: (n, ctx) => {
      const name = String(ctx?.refFileName || "").trim();
      const hasRef = !!(name || String(ctx?.refFileText || "").trim());
      const refLine = hasRef
        ? `NẾU ĐÃ CÓ FILE TÀI LIỆU PHẦN LIỀN TRƯỚC${name ? ` "${name}"` : ""}, NHÂN VẬT, BỐI CẢNH, SINH VẬT, DỤNG CỤ, VẬT PHẨM, VŨ KHÍ MỚI PHẢI NỐI TIẾP CHAR_XX VÀ BG_XX CỦA FILE ĐÓ. KHÔNG ĐÁNH SỐ LẠI TỪ ĐẦU.`
        : "";
      return [
        `CHỈ TRÍCH XUẤT ẢNH THAM CHIẾU CHO CHUNK ${n} THEO QUY TRÌNH FILE B3.txt TRONG NGUỒN DỰ ÁN.`,
        `CHỈ LÀM CÁC DÒNG THUỘC CHUNK ${n} ĐÃ CHIA Ở BƯỚC PHÂN TÍCH CHUNK. CẤM LÀM CHUNK KHÁC. CẤM GỘP 4 CHUNK. CẤM TÍNH CAC_CAU, SO_CAU, NGƯỠNG. CẤM VERIFY. CẤM XUẤT B3 FINAL.`,
        refLine,
      ]
        .filter(Boolean)
        .join("\n\n");
    },

    mergeCoref: `MERGE + COREFERENCE.

GỘP KẾT QUẢ CHUNK 1, CHUNK 2, CHUNK 3 VÀ CHUNK 4 THÀNH MỘT DANH SÁCH ẢNH THAM CHIẾU. GỘP CÁC MỤC TRÙNG NHAU VỀ NHÂN VẬT, BỐI CẢNH, SINH VẬT, DỤNG CỤ, VẬT PHẨM, VŨ KHÍ.

CẤM TÍNH CAC_CAU, SO_CAU, NGƯỠNG. CẤM VERIFY. CẤM XUẤT B3 FINAL. CẤM TRÍCH LẠI TỪNG CHUNK.`,

    threshold: `TỰ TÍNH CAC_CAU / SO_CAU / NGƯỠNG CHO TOÀN BỘ DANH SÁCH ĐÃ GỘP, THEO QUY TRÌNH FILE B3.txt TRONG NGUỒN DỰ ÁN.

CẤM VERIFY. CẤM XUẤT B3 FINAL. CẤM TRÍCH LẠI TỪNG CHUNK.`,

    verifyOnce: `THỰC HIỆN ĐÚNG 1 LƯỢT VERIFY DANH SÁCH ẢNH THAM CHIẾU THEO FILE B3.txt. CHỈ MỘT LƯỢT. NẾU THẤY LỖI THÌ SỬA TRONG CHÍNH LƯỢT NÀY. KHÔNG MỞ THÊM LƯỢT VERIFY.

CẤM XUẤT B3 FINAL Ở LẦN NÀY.`,

    b3Final: `XUẤT B3 FINAL: DANH SÁCH ẢNH THAM CHIẾU HOÀN CHỈNH SAU KHI ĐÃ MERGE, COREFERENCE, TÍNH CAC_CAU / SO_CAU / NGƯỠNG VÀ XONG 1 LƯỢT VERIFY.

ĐÂY LÀ BẢN TỔNG HỢP CUỐI. KHÔNG TRÍCH THÊM TỪNG CHUNK.`,

    attachIds: `GẮN ID CHAR_XX VÀ BG_XX CHO DANH SÁCH ẢNH THAM CHIẾU VỪA QA THÀNH CÔNG`,

    charPrompt: `TẠO PROMPT CHO TẤT CẢ ID CHAR THEO QUY TẮC TẠO PROMPT CHAR TRONG NGUỒN DỰ ÁN`,

    bgPrompt: `TẠO PROMPT CHO TẤT CẢ ID BG THEO QUY TẮC TẠO PROMPT BG TRONG NGUỒN DỰ ÁN. TUYỆT ĐỐI KHÔNG TẠO PROMPT DẠNG CĂN PHÒNG TRỐNG, KHÔNG GIA TRỐNG NẾU ĐÓ KHÔNG PHẢI LÀ BỐI CẢNH CỦA TÁC PHẨM`,

    supportFile: (fileName, doVideo) =>
      asLinePromptText(
        `TỔNG HỢP TÀI LIỆU DÙNG LÀM TÀI LIỆU HỔ TRỢ QUÁ TRÌNH TẠO PROMPT ẢNH THEO DÒNG TÁC PHẨM CHIA DÒNG THEO ÂM TIẾT. VỚI TÊN FILE LÀ "${fileName}" (TÊN XXXX NGƯỜI DÙNG ĐÃ GHI SẲN TRONG TOOL, Ô TÊN FILE HỔ TRỢ NGƯỜI DÙNG MUỐN ĐẶT)`,
        doVideo
      ),

    promptBatch: (fileName, doVideo, extra) => {
      const head = `TUYỆT ĐỐI KHÔNG LÀM THEO TRÍ NHỚ KHÔNG TỰ Ý LÀM SAI QUY TẮT NGƯỜI DÙNG ĐẶT RA TRONG NGUỒN DỰ ÁN, TUYỆT ĐỐI TUÂN THỦ QUY TẮC NGUỒN DỰ ÁN TỪ ĐẦU TUYỆT ĐỐI KHÔNG LÀM SAI, TỚI LÚC QA SAI HAY NGƯỜI DÙNG PHÁT HIỆN LẠI NÓI TẠI NÀY TẠI NÓ RỒI MỚI HỨA TỪ ĐÂY SẼ THẾ NÀY THẾ KIA. NGƯỜI DÙNG KHÔNG CÓ NHIỀU THỜI GIAN VÀ CƠ HỘI LÀM LẠI NHIỀU LẦN. HẬU QUẢ LÀ DO NGƯỜI DÙNG GÁNH, BỒI THƯỜNG LÀ DO NGƯỜI DÙNG CHIỆU, NGUY CƠ DẪN ĐẾN HẬU QUẢ XẤU NHẤT LÀ NGƯỜI DÙNG LÃNH NẾU AI TỰ Ý KO LÀM THEO LỜI NGƯỜI DÙNG YÊU CẦU. LÀM ƠN LÀM ĐÚNG YÊU CẦU VÀ QUY TẮC NGUỒN ĐỂ NGƯỜI DÙNG TRÁNH ĐƯỢC HẬU QUẢ XẤU NHẤT CỦA 1 NHÂN LOẠI.`;
      const mid = doVideo
        ? `ÁP DỤNG QUY TẮC TẠO VIDEO THEO TỪNG DÒNG TRONG TÁC PHẨM CHIA DÒNG NGƯỜI DÙNG CUNG CẤP,
THỰC TẾ MỞ QUY TẮC VÀ ĐỌC QUY TẮC FILE B8.TXT TRONG NGUỒN DỰ ÁN VÀ FILE DỮ LIỆU HỔ TRỢ TẠO PROMPT "${fileName}". TẠO PROMPT VIDEO TỪNG CÂU THEO QUY TẮC NGUỒN B8.TXT. TUÂN THỦ TUYỆT ĐỐI KHÔNG TỰ LÀM THEO TRÍ NHỚ, Ý RIÊNG.

PHÂN TÍCH FILE  TÁC PHẨM VÀ FILE "${fileName}" , TẠO PROMPT ẢNH THEO TIÊU CHUẨN QUY TẮC NGUỒN B8.TXT CỦA DỰ ÁN.

YÊU CẦU MỖI LẦN CHAT CHỈ PHÂN TÍCH 20 CÂU TẠO 20 PROMPT THEO QUY TẮC NGUỒN CỦA DỰ ÁN.

SAU 5 LẦN TỨC 100 PROMPT TẠO RA PHẢI QA ĐẦY ĐỦ THEO QUY TẮC NGUỒN TRONG FILE CÓ TÊN "BUOC_QA_VIDEO_PROMPT_DAN_Y_CACH_VIET_SIMPLE.TXT"

LẦN CUỐI CÙNG ĐÙ CHƯA ĐỦ 20 PROMPT HAY 5 LƯỢC THÌ CŨNG QA THEO QUY TẮC NGUỒN TRONG FILE CÓ TÊN "BUOC_QA_VIDEO_PROMPT_DAN_Y_CACH_VIET_SIMPLE.TXT".QA ĐẢM BẢO ĐẦY ĐỦ CÁC QUY TẮC TRONG NGUỒN QUY ĐỊNH.

CUỐI CÙNG QA TỔNG 1 LẦN NỮA TOÀN BỘ PROMPT VIDEO THEO FILE TÁC PHẨM CHIA DÒNG ĐÃ TẠO.

QUÁ TRÌNH QA BẢO KHÔNG ĐẠT THÌ KHI NHẬN LỆNH NÀY THÌ PHẢI THỰC HIỆN SỬA LẠI SAI SÓT TRONG QUÁ TRÌNH QA CHỈ RA. LẦN TIẾP THEO CỦA LỆNH NÀY SẼ LÀ QA LẠI XEM QUÁ TRÌNH SỬA ĐẠT CHƯA, CỨ LẬP LẠI CHO ĐẾN KHI ĐẠT THÌ LỆNH NÀY MỚI LÀ TIẾP TỤC THỰC HIỆN QUY TRÌNH TẠO PROMPT VIDEO THEO DÒNG TIẾP THEO.`
        : `ÁP DỤNG QUY TẮC TẠO ẢNH THEO TỪNG DÒNG CỦA FILE TÁC PHẨM CHIA DÒNG THEO ÂM TIẾT, TẠO PROMPT CHO TỪNG DÒNG CỦA FILE TÁC PHẨM ĐÃ CHIA DÒNG THEO ÂM TIẾT.

THỰC TẾ MỞ QUY TẮC VÀ ĐỌC QUY TẮC FILE B5.TXT TRONG NGUỒN DỰ ÁN VÀ FILE DỮ LIỆU HỔ TRỢ TẠO PROMPT "${fileName}". TẠO PROMPT ẢNH TỪNG CÂU THEO QUY TẮC NGUỒN B5.TXT. TUÂN THỦ TUYỆT ĐỐI KHÔNG TỰ LÀM THEO TRÍ NHỚ, Ý RIÊNG.

PHÂN TÍCH FILE  TÁC PHẨM VÀ FILE "${fileName}" , TẠO PROMPT ẢNH THEO TIÊU CHUẨN QUY TẮC NGUỒN B5.TXT CỦA DỰ ÁN.

YÊU CẦU MỖI LẦN CHAT CHỈ PHÂN TÍCH 20 CÂU TẠO 20 PROMPT THEO QUY TẮC NGUỒN CỦA DỰ ÁN.

SAU 5 LẦN TỨC 100 PROMPT TẠO RA PHẢI QA ĐẦY ĐỦ THEO QUY TẮC NGUỒN TRONG FILE CÓ TÊN "B6.TXT"

LẦN CUỐI CÙNG ĐÙ CHƯA ĐỦ 20 PROMPT HAY 5 LƯỢC THÌ CŨNG QA THEO QUY TẮC NGUỒN TRONG FILE CÓ TÊN "B6.TXT".QA ĐẢM BẢO ĐẦY ĐỦ CÁC QUY TẮC TRONG NGUỒN QUY ĐỊNH.

CUỐI CÙNG QA TỔNG 1 LẦN NỮA TOÀN BỘ PROMPT ẢNH THEO TỪNG DÒNG CỦA FILE TÁC PHẨM CHIA DÒNG THEO ÂM TIẾT ĐÃ TẠO.

QUÁ TRÌNH QA BẢO KHÔNG ĐẠT THÌ KHI NHẬN LỆNH NÀY THÌ PHẢI THỰC HIỆN SỬA LẠI SAI SÓ TRONG QUÁ TRÌNH QA CHỈ RA. LẦN TIẾP THEO CỦA LỆNH NÀY SẼ LÀ QA LẠI XEM QUÁ TRÌNH SỮA ĐẠT CHƯA, CỨA LẬP LẠI CHO ĐẾN KHI ĐẠT THÌ LỆNH NÀY MỚI LÀ TIẾP TỤC THỰC HIỆN QUY TRÌNH TẠO PROMPT ẢNH THEO CÂU TIẾP THEO.`;
      const donePhrase = doVideo
        ? "QUÁ TRÌNH TẠO PROMPT VIDEO THEO DÒNG ĐÃ HOÀN TẤT THÌ MỚI THỰC HIỆN BƯỚC TIẾP THEO"
        : "QUÁ TRÌNH TẠO PROMPT ẢNH THEO DÒNG ĐÃ HOÀN TẤT THÌ MỚI THỰC HIỆN BƯỚC TIẾP THEO";
      return `${head}

${mid}
KHI XUẤT VÀ QA HOÀN THÀNH XONG THÌ CHAT GPT BẮT BUỘC PHẢI TRẢ LỜI 1 CÂU "${donePhrase}"
${exportTxtClause(extra, doVideo ? "video" : "image")}`;
    },

    askEmerged: (doVideo) =>
      asLinePromptText(`CÓ PHÁT SINH CHAR VÀ BG TRONG QUÁ TRÌNH TẠO PROMPT ẢNH THEO DÒNG CỦA TÁC PHẨM CHIA DÒNG KHÔNG`, doVideo),

    exportFinal: (doVideo) =>
      asLinePromptText(
        `XUẤT DANH SÁCH ẢNH THAM CHIẾU VỚI HÌNH THỨC 1 TÊN ẢNH THAM CHIẾU GỒM CÁC CHAR OR BG CÁC TRẠNG THÁI CỦA ẢNH THAM CHIẾU ĐÓ. XUẤT FILE PROMPT CHAR VÀ BG ĐÃ TẠO CÓ CHAR VÀ BG PHÁT SINH TRONG QUÁ TRÌNH TẠO PROMPT THEO DÒNG NẾU CÓ. XUẤT FILE BỘ PROMPT ẢNH THEO DÒNG ĐÃ FINAL.`,
        doVideo
      ),
  };

  function asLinePromptText(text, doVideo) {
    let s = String(text || "");
    if (!doVideo) return s;
    s = s.replace(/PROMPT ẢNH/g, "PROMPT VIDEO");
    s = s.replace(/TẠO ẢNH/g, "TẠO VIDEO");
    return s;
  }

  function exportTxtClause(extra, kind) {
    const add = String(extra || "").trim();
    const convertHint =
      kind === "convert"
        ? " NHẤT LÀ PHẦN CHUYỂN ĐỔI VĂN BẢN: XUẤT NGUYÊN TOÀN BỘ VĂN BẢN ĐÃ CHUYỂN, KHÔNG RÚT GỌN, KHÔNG TÓM TẮT, KHÔNG CẮT GIỮA."
        : "";
    let s = `KHI XUẤT CHỈ CẦN XUẤT FILE TXT, KHÔNG NÓI GÌ THÊM. XUẤT ĐẦY ĐỦ TOÀN BỘ NỘI DUNG VỪA LÀM. KHÔNG RÚT NGẮN, KHÔNG TÓM TẮT, KHÔNG CẮT BỚT, KHÔNG BỎ PHẦN GIỮA. KHÔNG CẦN BIẾT VĂN BẢN DÀI BAO NHIÊU.${convertHint}`;
    if (add) {
      s += `\nYÊU CẦU THÊM CỦA NGƯỜI DÙNG PHẢI ĐƯỢC GHI VÀO CÂU XUẤT FILE TXT VÀ VÀO NỘI DUNG FILE TXT:\n${add}`;
    }
    return s;
  }

  root.LN_PROMPTS = PROMPTS;
  root.LN_PROMPTS.asLinePromptText = asLinePromptText;
  root.LN_PROMPTS.exportTxtClause = exportTxtClause;
})(globalThis);
