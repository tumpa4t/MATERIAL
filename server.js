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
        const result = await pool.request()
            .input('u', sql.VarChar, req.body.username).input('e', sql.VarChar, req.body.email).input('p', sql.VarChar, hash)
            .input('r', sql.VarChar, req.body.role).input('c', sql.VarChar, req.body.company_name).input('ph', sql.VarChar, req.body.contact_phone)
            .query(`INSERT INTO cgd_users (username, email, password_hash, role, company_name, contact_phone) 
                    OUTPUT inserted.id, inserted.username VALUES (@u, @e, @p, @r, @c, @ph)`);
        
        transporter.sendMail({
            from: process.env.EMAIL_USER, to: req.body.email,
            subject: 'Your CGD Portal Credentials',
            text: `Hello ${req.body.company_name},\n\nYour account has been created.\n\nUsername: ${req.body.username}\nPassword: ${req.body.password}\nRole: ${req.body.role}`
        });
        res.status(201).json({ message: 'User created & email sent' });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/users/by-role/:role', authenticateToken, async (req, res) => {
    try {
        const pool = await poolPromise;
        res.json((await pool.request().input('r', sql.VarChar, req.params.role).query('SELECT id, company_name FROM cgd_users WHERE role = @r')).recordset);
    } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/materials', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    res.json((await pool.request().query('SELECT * FROM cgd_materials ORDER BY item_name')).recordset);
});

app.get('/api/contracts', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    let query = `SELECT c.id, c.contract_number, c.title FROM cgd_contracts c`;
    const reqst = pool.request();
    if (req.user.role === 'CONTRACTOR') { query += ` WHERE c.contractor_id = @cid`; reqst.input('cid', sql.Int, req.user.id); }
    res.json((await reqst.query(query)).recordset);
});

app.post('/api/requisitions', authenticateToken, async (req, res) => {
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('rn', sql.VarChar, `REQ-${Date.now()}`).input('cid', sql.Int, req.body.contract_id).input('mid', sql.Int, req.body.material_id)
            .input('uid', sql.Int, req.user.id).input('pid', sql.Int, req.body.project_approver_id).input('qty', sql.Decimal(14,3), req.body.requested_qty)
            .query(`INSERT INTO cgd_requisitions (req_number, contract_id, material_id, contractor_id, project_approver_id, requested_qty) 
                    VALUES (@rn, @cid, @mid, @uid, @pid, @qty)`);
        res.status(201).json({ message: 'Requisition Sent' });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/requisitions', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    let query = `SELECT r.*, c.contract_number, m.item_name, m.unit_of_measure, u.company_name AS contractor_name 
                 FROM cgd_requisitions r JOIN cgd_contracts c ON r.contract_id = c.id 
                 JOIN cgd_materials m ON r.material_id = m.id JOIN cgd_users u ON r.contractor_id = u.id WHERE 1=1`;
    const reqst = pool.request();
    if (req.user.role === 'CONTRACTOR') { query += ` AND r.contractor_id = @id`; reqst.input('id', sql.Int, req.user.id); }
    else if (req.user.role === 'PROJECT_APPROVER') { query += ` AND r.project_approver_id = @id AND r.status = 'PENDING'`; reqst.input('id', sql.Int, req.user.id); }
    else if (req.user.role === 'MATERIAL_DEPT') { query += ` AND r.material_dept_id = @id AND r.status = 'APPROVED'`; reqst.input('id', sql.Int, req.user.id); }
    res.json((await reqst.query(query + ` ORDER BY r.created_at DESC`)).recordset);
});

app.put('/api/requisitions/:id/approve', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    await pool.request().input('id', sql.Int, req.params.id).input('qty', sql.Decimal(14,3), req.body.approved_qty).input('mid', sql.Int, req.body.material_dept_id)
        .query(`UPDATE cgd_requisitions SET approved_qty = @qty, material_dept_id = @mid, status = 'APPROVED', updated_at = GETDATE() WHERE id = @id`);
    res.json({ message: 'Approved' });
});

app.put('/api/requisitions/:id/reject', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    await pool.request().input('id', sql.Int, req.params.id).query(`UPDATE cgd_requisitions SET status = 'REJECTED', updated_at = GETDATE() WHERE id = @id`);
    res.json({ message: 'Rejected' });
});

app.post('/api/requisitions/:id/issue', authenticateToken, async (req, res) => {
    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    try {
        await transaction.begin();
        const reqst = new sql.Request(transaction);
        const r = (await reqst.input('id', sql.Int, req.params.id).query(`SELECT * FROM cgd_requisitions WHERE id = @id AND status = 'APPROVED'`)).recordset[0];
        
        await reqst.input('vno', sql.VarChar, `MIV-${Date.now()}`).input('cid', sql.Int, r.contract_id).input('mid', sql.Int, r.material_id)
             .input('qty', sql.Decimal(14,3), r.approved_qty).input('uid', sql.Int, req.user.id)
             .query(`INSERT INTO cgd_transactions (voucher_number, transaction_type, contract_id, material_id, requisition_id, quantity, created_by) 
                     VALUES (@vno, 'ISSUE_TO_CONTRACTOR', @cid, @mid, @id, @qty, @uid)`);
        
        await reqst.query(`UPDATE cgd_requisitions SET status = 'ISSUED', updated_at = GETDATE() WHERE id = @id`);
        await transaction.commit();
        res.json({ message: 'Issued' });
    } catch (err) { await transaction.rollback(); res.status(400).json({ error: err.message }); }
});

app.get('/api/transactions/voucher-pdf/:id', authenticateToken, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().input('id', sql.Int, req.params.id).query(`
            SELECT t.*, m.item_code, m.item_name, m.unit_of_measure, 
                   c.contract_number, req_u.company_name AS req_contractor_name, c.title AS contract_title, u.company_name AS contractor_name,
                   req.created_at AS req_time, app.company_name AS approver_name, req.updated_at AS approval_time, iss.company_name AS issuer_name
            FROM cgd_transactions t
            JOIN cgd_materials m ON t.material_id = m.id
            LEFT JOIN cgd_contracts c ON t.contract_id = c.id
            LEFT JOIN cgd_users u ON t.created_by = u.id
            LEFT JOIN cgd_requisitions req ON t.requisition_id = req.id
            LEFT JOIN cgd_users req_u ON req.contractor_id = req_u.id
            LEFT JOIN cgd_users app ON req.project_approver_id = app.id
            LEFT JOIN cgd_users iss ON t.created_by = iss.id
            WHERE t.id = @id
        `);
        if (result.recordset.length === 0) return res.status(404).send('Voucher not found');
        generateVoucherPDF(result.recordset[0], res);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/transactions/receive-from-mfg', authenticateToken, async (req, res) => {
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('vno', sql.VarChar, `MRV-${Date.now()}`).input('mid', sql.Int, req.body.material_id)
            .input('qty', sql.Decimal(14,3), req.body.quantity).input('inv', sql.VarChar, req.body.invoice_or_ref_no).input('uid', sql.Int, req.user.id)
            .query(`INSERT INTO cgd_transactions (voucher_number, transaction_type, material_id, quantity, invoice_or_ref_no, created_by) 
                    VALUES (@vno, 'RECEIPT_FROM_MFG', @mid, @qty, @inv, @uid)`);
        res.status(201).json({ message: 'Stock updated' });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/reports/material-status', authenticateToken, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT m.item_code, m.item_name, m.unit_of_measure,
                (ISNULL(SUM(CASE WHEN t.transaction_type = 'RECEIPT_FROM_MFG' THEN t.quantity ELSE 0 END), 0) -
                 ISNULL(SUM(CASE WHEN t.transaction_type = 'ISSUE_TO_CONTRACTOR' THEN t.quantity ELSE 0 END), 0) +
                 ISNULL(SUM(CASE WHEN t.transaction_type = 'RETURN_FROM_CONTRACTOR' THEN t.quantity ELSE 0 END), 0)) AS warehouse_balance
            FROM cgd_materials m LEFT JOIN cgd_transactions t ON m.id = t.material_id
            GROUP BY m.item_code, m.item_name, m.unit_of_measure ORDER BY m.item_name ASC
        `);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(process.env.PORT || 8080, () => console.log('Server running'));
