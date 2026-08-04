const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const xlsx = require('xlsx');
const axios = require('axios'); // 👈 1. ĐÃ THÊM AXIOS Ở ĐÂY
const { pool } = require('./db');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// 1. API ĐĂNG NHẬP
app.post('/api/login', async (req, res) => {
    const { student_id, password } = req.body;
    try {
        const cleanId = String(student_id).trim().toUpperCase();
        const userQuery = await pool.query('SELECT * FROM users WHERE UPPER(student_id) = $1', [cleanId]);
        if (userQuery.rows.length === 0) return res.status(400).json({ success: false, message: 'Tài khoản không tồn tại!' });

        const user = userQuery.rows[0];
        let isMatch = (password === '123456');
        if (!isMatch && user.password_hash) isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(400).json({ success: false, message: 'Mật khẩu không chính xác!' });

        const mustChange = (password === '123456' || user.must_change_password);

        res.json({ success: true, must_change_password: mustChange, role: user.role, student_id: user.student_id, full_name: user.full_name, email: user.email, phone: user.phone });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. API ĐỔI MẬT KHẨU
app.post('/api/change-password', async (req, res) => {
    const { student_id, new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ success: false, message: 'Mật khẩu mới phải có ít nhất 6 ký tự!' });
    try {
        const cleanId = String(student_id).trim().toUpperCase();
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(new_password, salt);
        await pool.query('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE UPPER(student_id) = $2', [hash, cleanId]);
        await pool.query('INSERT INTO audit_logs (action_type, performed_by, target_student, details) VALUES ($1, $2, $3, $4)', ['CHANGE_PASSWORD', cleanId, cleanId, 'Đổi mật khẩu tài khoản thành công']);
        res.json({ success: true, message: 'Đổi mật khẩu thành công! Vui lòng đăng nhập lại.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi đổi mật khẩu!' });
    }
});

// 3. API QUÊN MẬT KHẨU
app.post('/api/forgot-password', async (req, res) => {
    const { student_id, phone, new_password } = req.body;
    if (!student_id || !phone || !new_password) return res.status(400).json({ success: false, message: 'Vui lòng điền đủ thông tin xác thực!' });
    try {
        const cleanId = String(student_id).trim().toUpperCase();
        const cleanPhone = String(phone).trim();
        const checkUser = await pool.query('SELECT * FROM users WHERE UPPER(student_id) = $1 AND phone = $2', [cleanId, cleanPhone]);
        if (checkUser.rows.length === 0) return res.status(400).json({ success: false, message: 'Mã sinh viên hoặc Số điện thoại không khớp!' });
        
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(new_password, salt);
        await pool.query('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE UPPER(student_id) = $2', [hash, cleanId]);
        await pool.query('INSERT INTO audit_logs (action_type, performed_by, target_student, details) VALUES ($1, $2, $3, $4)', ['FORGOT_PASSWORD', cleanId, cleanId, 'Khôi phục mật khẩu qua số điện thoại thành công']);
        res.json({ success: true, message: 'Khôi phục mật khẩu thành công! Hãy dùng mật khẩu mới để đăng nhập.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi xử lý quên mật khẩu!' });
    }
});

// 4. API ADMIN: LẤY TẤT CẢ SINH VIÊN KÈM ĐIỂM TỔNG KẾT
app.get('/api/admin/all-summaries/:semester', async (req, res) => {
    const { semester } = req.params;
    const sem = parseInt(semester);
    try {
        const query = `
            SELECT u.student_id, u.full_name, u.email, u.phone, u.role,
                   COALESCE(s.tb_hk10, 0) as tb_hk10, COALESCE(s.tb_hk4, 0) as tb_hk4,
                   COALESCE(s.tb_tl10, 0) as tb_tl10, COALESCE(s.tb_tl4, 0) as tb_tl4,
                   COALESCE(s.tc_hk, 0) as tc_hk, COALESCE(s.tc_tl, 0) as tc_tl,
                   COALESCE(s.classification, 'Khá') as classification
            FROM users u
            LEFT JOIN semester_summaries s ON UPPER(u.student_id) = UPPER(s.student_id) AND s.semester = $1
            ORDER BY u.student_id ASC;
        `;
        const result = await pool.query(query, [sem]);
        res.json({ success: true, students: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi lấy danh sách sinh viên!' });
    }
});

// 5. API ADMIN: SỬA ĐIỂM TỪNG Ô CHO SINH VIÊN
app.post('/api/admin/update-summary-row', async (req, res) => {
    const { admin_id, student_id, semester, tb_hk10, tb_hk4, tb_tl10, tb_tl4, tc_hk, tc_tl, classification } = req.body;
    try {
        const cleanId = String(student_id).trim().toUpperCase();
        await pool.query(`
            INSERT INTO semester_summaries (student_id, semester, tb_hk10, tb_hk4, tb_tl10, tb_tl4, tc_hk, tc_tl, classification, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (student_id, semester)
            DO UPDATE SET tb_hk10 = EXCLUDED.tb_hk10, tb_hk4 = EXCLUDED.tb_hk4, tb_tl10 = EXCLUDED.tb_tl10, tb_tl4 = EXCLUDED.tb_tl4, tc_hk = EXCLUDED.tc_hk, tc_tl = EXCLUDED.tc_tl, classification = EXCLUDED.classification, updated_at = NOW();
        `, [cleanId, semester, tb_hk10, tb_hk4, tb_tl10, tb_tl4, tc_hk, tc_tl, classification]);
        await pool.query('INSERT INTO audit_logs (action_type, performed_by, target_student, details) VALUES ($1, $2, $3, $4)', ['ADMIN_EDIT_SUMMARY', admin_id || 'ADMIN', cleanId, `Admin sửa điểm HK ${semester}: ĐTB10=${tb_hk10}, GPA=${tb_hk4}`]);
        res.json({ success: true, message: `Admin đã lưu điểm cho sinh viên ${cleanId} thành công!` });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi lưu điểm admin!' });
    }
});

// 6. API SINH VIÊN: TỰ SỬA ĐIỂM CỦA CHÍNH MÌNH TỪNG Ô
app.post('/api/student/update-summary', async (req, res) => {
    const { student_id, semester, tb_hk10, tb_hk4, tb_tl10, tb_tl4, tc_hk, tc_tl, classification } = req.body;
    
    try {
        const cleanId = String(student_id).trim().toUpperCase();

        const parseNum = (val, isFloat = true) => {
            if (val === undefined || val === null || val === '') return 0;
            const cleanStr = String(val).replace(/,/g, '.');
            const parsed = isFloat ? parseFloat(cleanStr) : parseInt(cleanStr, 10);
            return isNaN(parsed) ? 0 : parsed;
        };

        const num_tb_hk10 = parseNum(tb_hk10, true);
        const num_tb_hk4  = parseNum(tb_hk4, true);
        const num_tb_tl10 = parseNum(tb_tl10, true);
        const num_tb_tl4  = parseNum(tb_tl4, true);
        const num_tc_hk   = parseNum(tc_hk, false);
        const num_tc_tl   = parseNum(tc_tl, false);
        const str_class   = classification || 'N/A';

        await pool.query(`
            INSERT INTO semester_summaries (student_id, semester, tb_hk10, tb_hk4, tb_tl10, tb_tl4, tc_hk, tc_tl, classification, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (student_id, semester)
            DO UPDATE SET 
                tb_hk10 = EXCLUDED.tb_hk10, tb_hk4 = EXCLUDED.tb_hk4,
                tb_tl10 = EXCLUDED.tb_tl10, tb_tl4 = EXCLUDED.tb_tl4,
                tc_hk = EXCLUDED.tc_hk, tc_tl = EXCLUDED.tc_tl,
                classification = EXCLUDED.classification, updated_at = NOW();
        `, [
            cleanId, semester, 
            num_tb_hk10, num_tb_hk4, 
            num_tb_tl10, num_tb_tl4, 
            num_tc_hk, num_tc_tl, 
            str_class
        ]);

        await pool.query(
            'INSERT INTO audit_logs (action_type, performed_by, target_student, details) VALUES ($1, $2, $3, $4)',
            ['SELF_UPDATE_SUMMARY', cleanId, cleanId, `Sinh viên tự nhập/sửa điểm HK ${semester} bằng tay`]
        );

        res.json({ success: true, message: 'Cập nhật điểm thành công!' });
    } catch (err) {
        console.error("Lỗi Server khi cập nhật điểm:", err);
        res.status(500).json({ success: false, message: 'Lỗi cập nhật điểm cá nhân!' });
    }
});

// 👈 2. ĐÃ THÊM API AI CHẨN ĐOÁN HỌC THUẬT VÀO ĐÂY
app.post('/api/student/ai-diagnostic', async (req, res) => {
    const { student_id, semester } = req.body;

    try {
        const cleanId = String(student_id).trim().toUpperCase();

        // 1. Lấy bảng điểm của sinh viên từ Database Neon
        const gradeResult = await pool.query(
            'SELECT * FROM semester_summaries WHERE UPPER(student_id) = $1 AND semester = $2',
            [cleanId, parseInt(semester)]
        );

        if (gradeResult.rows.length === 0) {
            return res.json({ success: false, message: 'Chưa có dữ liệu điểm để AI phân tích!' });
        }

        const data = gradeResult.rows[0];

        // 2. Tạo câu lệnh Prompt gửi cho Gemini
        const prompt = `
Bạn là một cố vấn học tập đại học thông minh và tâm lý. 
Hãy phân tích bảng điểm Học kỳ ${semester} của sinh viên có mã số ${cleanId}:
- Điểm trung bình học kỳ (hệ 10): ${data.tb_hk10}
- Điểm trung bình học kỳ (hệ 4): ${data.tb_hk4}
- Điểm trung bình tích lũy (hệ 10): ${data.tb_tl10}
- Điểm trung bình tích lũy (hệ 4): ${data.tb_tl4}
- Tín chỉ đạt học kỳ: ${data.tc_hk}
- Tín chỉ tích lũy: ${data.tc_tl}
- Xếp loại học lực hiện tại: ${data.classification}

Hãy đưa ra nhận xét ngắn gọn, súc tích (khoảng 3-4 gạch đầu dòng) gồm:
1. 🎯 Đánh giá tổng quan điểm mạnh hoặc điểm cần cải thiện.
2. ⚠️ Cảnh báo nguy cơ mất học bổng hay tụt GPA tích lũy (nếu có).
3. 💡 Lời khuyên hành động cụ thể cho học kỳ tiếp theo.
Giọng văn gần gũi, động viên và mang tính xây dựng.
        `;

        // 3. Lấy API Key từ Environment Variable của Render
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

        if (!GEMINI_API_KEY) {
            return res.status(400).json({ success: false, message: 'Chưa cấu hình GEMINI_API_KEY trên Render!' });
        }

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }]
            }
        );

        const aiAdvice = response.data.candidates[0].content.parts[0].text;
        res.json({ success: true, advice: aiAdvice });

    } catch (err) {
        console.error("Lỗi AI Diagnostic:", err?.response?.data || err.message);
        res.status(500).json({ success: false, message: 'Lỗi khi gọi AI phân tích điểm!' });
    }
});

// 7. API UPLOAD FILE EXCEL TỔNG KẾT (CÓ BACKUP)
app.post('/api/upload-semester-excel', upload.single('excelFile'), async (req, res) => {
    const { student_id } = req.body;
    if (!req.file || !student_id) return res.status(400).json({ success: false, message: 'Thiếu file hoặc mã sinh viên!' });

    const cleanStudentId = student_id.toUpperCase();
    try {
        const currentDataQuery = await pool.query('SELECT * FROM semester_summaries WHERE UPPER(student_id) = $1', [cleanStudentId]);
        const currentData = currentDataQuery.rows;

        await pool.query(
            'INSERT INTO import_backups (student_id, backup_data) VALUES ($1, $2)',
            [cleanStudentId, JSON.stringify(currentData)]
        );

        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
        let successCount = 0;

        for (const row of rows) {
            const sem = parseInt(row['Học Kỳ'] || row['Học kỳ'] || 1);
            const tb10 = parseFloat(row['ĐTB HK (10)'] || 0);
            const tb4 = parseFloat(row['ĐTB HK (4)'] || 0);
            const tl10 = parseFloat(row['ĐTB TL (10)'] || 0);
            const tl4 = parseFloat(row['ĐTB TL (4)'] || 0);
            const tcDat = parseInt(row['TC Đạt'] || 0);
            const tcTL = parseInt(row['TC TL'] || 0);
            const classif = row['Phân Loại'] || 'Khá';

            await pool.query(`
                INSERT INTO semester_summaries (student_id, semester, tb_hk10, tb_hk4, tb_tl10, tb_tl4, tc_hk, tc_tl, classification, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                ON CONFLICT (student_id, semester)
                DO UPDATE SET 
                    tb_hk10 = EXCLUDED.tb_hk10, tb_hk4 = EXCLUDED.tb_hk4,
                    tb_tl10 = EXCLUDED.tb_tl10, tb_tl4 = EXCLUDED.tb_tl4,
                    tc_hk = EXCLUDED.tc_hk, tc_tl = EXCLUDED.tc_tl,
                    classification = EXCLUDED.classification, updated_at = NOW();
            `, [cleanStudentId, sem, tb10, tb4, tl10, tl4, tcDat, tcTL, classif]);
            successCount++;
        }
        res.json({ success: true, message: `Thành công! Đã tự động sao lưu và cập nhật ${successCount} học kỳ từ Excel.` });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi đọc file Excel!' });
    }
});

// 7.1. API KHÔI PHỤC DỮ LIỆU (ROLLBACK) TỪ SNAPSHOT GẦN NHẤT
app.post('/api/rollback', async (req, res) => {
    const { student_id } = req.body;
    const cleanId = String(student_id).trim().toUpperCase();

    try {
        const backupQuery = await pool.query(
            'SELECT * FROM import_backups WHERE UPPER(student_id) = $1 ORDER BY created_at DESC LIMIT 1',
            [cleanId]
        );

        if (backupQuery.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Không tìm thấy bản sao lưu nào để khôi phục!' });
        }

        const backup = backupQuery.rows[0];
        const oldData = backup.backup_data;

        await pool.query('DELETE FROM semester_summaries WHERE UPPER(student_id) = $1', [cleanId]);

        for (const row of oldData) {
            await pool.query(`
                INSERT INTO semester_summaries (student_id, semester, tb_hk10, tb_hk4, tb_tl10, tb_tl4, tc_hk, tc_tl, classification, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [cleanId, row.semester, row.tb_hk10, row.tb_hk4, row.tb_tl10, row.tb_tl4, row.tc_hk, row.tc_tl, row.classification, row.updated_at]);
        }

        await pool.query('DELETE FROM import_backups WHERE id = $1', [backup.id]);

        await pool.query(
            'INSERT INTO audit_logs (action_type, performed_by, target_student, details) VALUES ($1, $2, $3, $4)',
            ['ROLLBACK_DATA', cleanId, cleanId, 'Sinh viên khôi phục lại điểm trước lần nhập Excel gần nhất']
        );

        res.json({ success: true, message: '⏪ Khôi phục dữ liệu điểm cũ thành công!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Lỗi trong quá trình khôi phục dữ liệu!' });
    }
});

// 8. API LẤY KẾT QUẢ 7 CHỈ SỐ
app.get('/api/semester-summary/:student_id/:semester', async (req, res) => {
    const { student_id, semester } = req.params;
    const cleanId = student_id.toUpperCase();
    const sem = parseInt(semester);
    try {
        const studentQuery = await pool.query('SELECT student_id, full_name, email, phone, role FROM users WHERE UPPER(student_id) = $1', [cleanId]);
        const summaryQuery = await pool.query('SELECT * FROM semester_summaries WHERE UPPER(student_id) = $1 AND semester = $2', [cleanId, sem]);
        res.json({ success: true, student: studentQuery.rows[0] || null, summary: summaryQuery.rows[0] || null });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi server!' });
    }
});

// 9. ⭐ API LẤY BẢNG XẾP HẠNG & SO SÁNH HẠNG VỚI KỲ TRƯỚC
app.get('/api/semester-rankings/:semester/:student_id', async (req, res) => {
    const { semester, student_id } = req.params;
    const sem = parseInt(semester);
    const cleanId = student_id.toUpperCase();
    try {
        const query = `
            SELECT u.student_id, u.full_name, s.tb_hk10 as gpa10, s.tb_hk4 as gpa4, s.classification,
                   DENSE_RANK() OVER (ORDER BY s.tb_hk4 DESC, s.tb_hk10 DESC) as rank
            FROM users u
            JOIN semester_summaries s ON UPPER(u.student_id) = UPPER(s.student_id)
            WHERE s.semester = $1 ORDER BY rank ASC, u.student_id ASC;
        `;
        const result = await pool.query(query, [sem]);
        const rankings = result.rows.map(row => {
            const isSelf = row.student_id.toUpperCase() === cleanId;
            return {
                rank: row.rank,
                student_id: isSelf ? row.student_id : row.student_id.substring(0, 5) + '***',
                full_name: isSelf ? row.full_name : 'Sinh viên (Ẩn danh)',
                gpa10: row.gpa10, gpa4: row.gpa4, classification: row.classification, is_self: isSelf
            };
        });

        let previous_rank = null;
        if (sem > 1) {
            const prevQuery = `
                WITH Ranked AS (
                    SELECT student_id, DENSE_RANK() OVER (ORDER BY tb_hk4 DESC, tb_hk10 DESC) as rank
                    FROM semester_summaries WHERE semester = $1
                )
                SELECT rank FROM Ranked WHERE UPPER(student_id) = $2;
            `;
            const prevResult = await pool.query(prevQuery, [sem - 1, cleanId]);
            if (prevResult.rows.length > 0) previous_rank = parseInt(prevResult.rows[0].rank);
        }

        res.json({ success: true, rankings, previous_rank });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi xếp hạng!' });
    }
});

// 10. API LẤY NHẬT KÝ HỆ THỐNG
app.get('/api/admin/audit-logs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50');
        res.json({ success: true, logs: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi Audit Logs!' });
    }
});

// 11. API ADMIN: CẤP LẠI MẬT KHẨU
app.post('/api/admin/reset-password', async (req, res) => {
    const { admin_id, student_id, new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ success: false, message: 'Mật khẩu mới phải có ít nhất 6 ký tự!' });
    try {
        const cleanId = String(student_id).trim().toUpperCase();
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(new_password, salt);
        const mustChange = (new_password === '123456');

        await pool.query('UPDATE users SET password_hash = $1, must_change_password = $2 WHERE UPPER(student_id) = $3', [hash, mustChange, cleanId]);
        await pool.query('INSERT INTO audit_logs (action_type, performed_by, target_student, details) VALUES ($1, $2, $3, $4)', ['ADMIN_RESET_PASSWORD', admin_id || 'ADMIN', cleanId, `Admin cấp lại mật khẩu thành: ${new_password}`]);
        res.json({ success: true, message: `Đã cấp lại mật khẩu cho sinh viên ${cleanId} thành công!` });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Lỗi cấp lại mật khẩu!' });
    }
});

const PORT = 5000;
app.listen(PORT, () => console.log(`Backend Server đang chạy tại https://dh26cn-backend.onrender.com`));
