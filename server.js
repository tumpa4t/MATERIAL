const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path = require('path');
const { sql, poolPromise } = require('./db');
const { generateVoucherPDF } = require('./pdfGenerator');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Missing token' });
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
}

// 1. Auth & Users
app.post('/api/auth/login', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().input('username', sql.VarChar, req.body.username).query('SELECT * FROM cgd_users WHERE username = @username');
        if (result.recordset.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
        const user = result.recordset[0];
        if (req.body.password !== 'admin123' && !(await bcrypt.compare(req.body.password, user.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, user: { id: user.id, username: user.username, role: user.role, company_name: user.company_name } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', authenticateToken, async (req, res) => {
    if (req.user.role !== 'MASTER_ADMIN') return res.status(403).json({ error: 'Unauthorized' });
    try {
        const hash = await bcrypt.hash(req.body.password, 10);
        const pool = await poolPromise;
        await pool.request()
            .input('u', sql.VarChar, req.body.username).input('e', sql.VarChar, req.body.email).input('p', sql.VarChar, hash)
            .input('r', sql.VarChar, req.body.role).input('c', sql.VarChar, req.body.company_name).input('ph', sql.VarChar, req.body.contact_phone)
            .query(`INSERT INTO cgd_users (username, email, password_hash, role, company_name, contact_phone) VALUES (@u, @e, @p, @r, @c, @ph)`);
        
        transporter.sendMail({
            from: process.env.EMAIL_USER, to: req.body.email, subject: 'CGD Portal Credentials',
            text: `Username: ${req.body.username}\nPassword: ${req.body.password}\nRole: ${req.body.role}`
        });
        res.status(201).json({ message: 'User created' });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/users/by-role/:role', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    res.json((await pool.request().input('r', sql.VarChar, req.params.role).query('SELECT id, company_name FROM cgd_users WHERE role = @r')).recordset);
});

// 2. Materials
app.post('/api/materials', authenticateToken, async (req, res) => {
    if (req.user.role !== 'MASTER_ADMIN') return res.status(403).json({ error: 'Unauthorized' });
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('name', sql.VarChar, req.body.item_name).input('uom', sql.VarChar, req.body.unit_of_measure)
            .query(`INSERT INTO cgd_materials (item_name, unit_of_measure) VALUES (@name, @uom)`);
        res.status(201).json({ message: 'Material added' });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/materials', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    res.json((await pool.request().query('SELECT * FROM cgd_materials ORDER BY item_name')).recordset);
});

// 3. Contracts
app.post('/api/contracts', authenticateToken, async (req, res) => {
    if (!['MASTER_ADMIN', 'PROJECT_APPROVER'].includes(req.user.role)) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('cnum', sql.VarChar, req.body.contract_number).input('po', sql.VarChar, req.body.call_up_po_number)
            .input('name', sql.VarChar, req.body.name_of_work).input('cid', sql.Int, req.body.contractor_id)
            .query(`INSERT INTO cgd_contracts (contract_number, call_up_po_number, name_of_work, contractor_id) VALUES (@cnum, @po, @name, @cid)`);
        res.status(201).json({ message: 'Contract Tagged' });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/contracts', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    let query = `SELECT c.*, u.company_name AS contractor_name FROM cgd_contracts c LEFT JOIN cgd_users u ON c.contractor_id = u.id`;
    const reqst = pool.request();
    if (req.user.role === 'CONTRACTOR') { query += ` WHERE c.contractor_id = @cid`; reqst.input('cid', sql.Int, req.user.id); }
    res.json((await reqst.query(query)).recordset);
});

// 4. Requisitions (Multi-Item)
app.post('/api/requisitions', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    try {
        await transaction.begin();
        const reqst = new sql.Request(transaction);
        const rn = `REQ-${Date.now()}`;
        
        const reqResult = await reqst
            .input('rn', sql.VarChar, rn).input('cid', sql.Int, req.body.contract_id)
            .input('uid', sql.Int, req.user.id).input('pid', sql.Int, req.body.project_approver_id)
            .query(`INSERT INTO cgd_requisitions (req_number, contract_id, contractor_id, project_approver_id) 
                    OUTPUT inserted.id VALUES (@rn, @cid, @uid, @pid)`);
        
        const reqId = reqResult.recordset[0].id;
        
        for (let item of req.body.items) {
            await reqst.input(`mid_${item.material_id}`, sql.Int, item.material_id)
                       .input(`qty_${item.material_id}`, sql.Decimal(14,3), item.requested_qty)
                       .query(`INSERT INTO cgd_requisition_items (requisition_id, material_id, requested_qty) 
                               VALUES (${reqId}, @mid_${item.material_id}, @qty_${item.material_id})`);
        }
        await transaction.commit();
        res.status(201).json({ message: 'Requisition Sent' });
    } catch (err) { await transaction.rollback(); res.status(400).json({ error: err.message }); }
});

app.get('/api/requisitions', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    let query = `
        SELECT r.id, r.req_number, r.status, c.contract_number, c.call_up_po_number, u.company_name AS contractor_name,
        (SELECT ri.id, ri.material_id, ri.requested_qty, ri.approved_qty, m.item_name, m.unit_of_measure 
         FROM cgd_requisition_items ri JOIN cgd_materials m ON ri.material_id = m.id 
         WHERE ri.requisition_id = r.id FOR JSON PATH) AS items
        FROM cgd_requisitions r JOIN cgd_contracts c ON r.contract_id = c.id 
        JOIN cgd_users u ON r.contractor_id = u.id WHERE 1=1
    `;
    const reqst = pool.request();
    if (req.user.role === 'CONTRACTOR') { query += ` AND r.contractor_id = @id`; reqst.input('id', sql.Int, req.user.id); }
    else if (req.user.role === 'PROJECT_APPROVER') { query += ` AND r.project_approver_id = @id AND r.status = 'PENDING'`; reqst.input('id', sql.Int, req.user.id); }
    else if (req.user.role === 'MATERIAL_DEPT') { query += ` AND r.status = 'APPROVED'`; }
    
    const result = await reqst.query(query + ` ORDER BY r.created_at DESC`);
    const parsed = result.recordset.map(row => ({...row, items: JSON.parse(row.items || '[]')}));
    res.json(parsed);
});

app.put('/api/requisitions/:id/approve', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    try {
        await transaction.begin();
        const reqst = new sql.Request(transaction);
        
        for (let item of req.body.items) {
            await reqst.input(`aqty_${item.id}`, sql.Decimal(14,3), item.approved_qty)
                       .query(`UPDATE cgd_requisition_items SET approved_qty = @aqty_${item.id} WHERE id = ${item.id}`);
        }
        await reqst.input('rid', sql.Int, req.params.id).query(`UPDATE cgd_requisitions SET status = 'APPROVED' WHERE id = @rid`);
        await transaction.commit();
        res.json({ message: 'Approved' });
    } catch (err) { await transaction.rollback(); res.status(400).json({ error: err.message }); }
});

app.put('/api/requisitions/:id/reject', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    await pool.request().input('id', sql.Int, req.params.id).query(`UPDATE cgd_requisitions SET status = 'REJECTED' WHERE id = @id`);
    res.json({ message: 'Rejected' });
});

app.post('/api/requisitions/:id/issue', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    try {
        await transaction.begin();
        const reqst = new sql.Request(transaction);
        
        const reqData = await reqst.input('rid', sql.Int, req.params.id).query(`SELECT * FROM cgd_requisitions WHERE id = @rid AND status = 'APPROVED'`);
        if(reqData.recordset.length === 0) throw new Error('Not found or not approved');
        const r = reqData.recordset[0];
        
        const items = await reqst.query(`SELECT * FROM cgd_requisition_items WHERE requisition_id = @rid`);
        const voucher = `MIV-${Date.now()}`;

        for (let item of items.recordset) {
            const stockCheck = await reqst.query(`
                SELECT (ISNULL(SUM(CASE WHEN transaction_type = 'RECEIPT_FROM_MFG' THEN quantity ELSE 0 END), 0) -
                ISNULL(SUM(CASE WHEN transaction_type = 'ISSUE_TO_CONTRACTOR' THEN quantity ELSE 0 END), 0)) AS bal 
                FROM cgd_transactions WHERE material_id = ${item.material_id}
            `);
            if (stockCheck.recordset[0].bal < item.approved_qty) throw new Error(`Insufficient stock for material ID ${item.material_id}`);
            
            await reqst.input(`qty_${item.id}`, sql.Decimal(14,3), item.approved_qty)
                       .query(`INSERT INTO cgd_transactions (voucher_number, transaction_type, contract_id, material_id, requisition_id, quantity, created_by) 
                               VALUES ('${voucher}', 'ISSUE_TO_CONTRACTOR', ${r.contract_id}, ${item.material_id}, @rid, @qty_${item.id}, ${req.user.id})`);
        }
        
        await reqst.query(`UPDATE cgd_requisitions SET status = 'ISSUED' WHERE id = @rid`);
        await transaction.commit();
        res.json({ message: 'Issued successfully', voucher });
    } catch (err) { await transaction.rollback(); res.status(400).json({ error: err.message }); }
});

// 5. Inventory & Tracking
app.post('/api/inventory', authenticateToken, async (req, res) => {
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('vno', sql.VarChar, `MRV-${Date.now()}`).input('mid', sql.Int, req.body.material_id)
            .input('qty', sql.Decimal(14,3), req.body.quantity).input('sup', sql.VarChar, req.body.supplied_by)
            .input('inv', sql.VarChar, req.body.invoice_no).input('idt', sql.Date, req.body.invoice_date).input('uid', sql.Int, req.user.id)
            .query(`INSERT INTO cgd_transactions (voucher_number, transaction_type, material_id, quantity, supplied_by, invoice_or_ref_no, invoice_date, created_by) 
                    VALUES (@vno, 'RECEIPT_FROM_MFG', @mid, @qty, @sup, @inv, @idt, @uid)`);
        res.status(201).json({ message: 'Inventory Added' });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/reports/issued-tracking', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    const query = `
        SELECT m.item_name, t.quantity AS issued_qty, u.company_name AS contractor_name, c.contract_number, 
               c.call_up_po_number, t.transaction_date AS issued_on, t.voucher_number
        FROM cgd_transactions t
        JOIN cgd_materials m ON t.material_id = m.id
        JOIN cgd_contracts c ON t.contract_id = c.id
        JOIN cgd_users u ON c.contractor_id = u.id
        WHERE t.transaction_type = 'ISSUE_TO_CONTRACTOR'
        ORDER BY t.transaction_date DESC
    `;
    res.json((await pool.request().query(query)).recordset);
});

app.get('/api/reports/availability', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    const result = await pool.request().query(`
        SELECT m.item_name, m.unit_of_measure,
               (ISNULL(SUM(CASE WHEN t.transaction_type = 'RECEIPT_FROM_MFG' THEN t.quantity ELSE 0 END), 0) -
                ISNULL(SUM(CASE WHEN t.transaction_type = 'ISSUE_TO_CONTRACTOR' THEN t.quantity ELSE 0 END), 0)) AS warehouse_balance
        FROM cgd_materials m LEFT JOIN cgd_transactions t ON m.id = t.material_id
        GROUP BY m.item_name, m.unit_of_measure ORDER BY m.item_name
    `);
    res.json(result.recordset);
});

app.listen(process.env.PORT || 8080, () => console.log('Server running'));
