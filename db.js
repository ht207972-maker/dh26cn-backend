const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_JbsqTy1BExL4@ep-sparkling-violet-az7fi5b8.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
    ssl: {
        rejectUnauthorized: false
    }
});

pool.connect((err, client, release) => {
    if (err) {
        return console.error('Lỗi kết nối Database Neon:', err.stack);
    }
    console.log('⚡ Đã kết nối thành công với Database Online trên Neon!');
    release();
});

module.exports = { pool };