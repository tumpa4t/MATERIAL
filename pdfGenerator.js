const PDFDocument = require('pdfkit');

function generateVoucherPDF(txData, res) {
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${txData.voucher_number}.pdf`);
    doc.pipe(res);

    doc.fontSize(18).text('CGD MATERIAL MANAGEMENT SYSTEM', { align: 'center', bold: true });
    doc.moveDown(0.5);

    const isIssue = txData.transaction_type === 'ISSUE_TO_CONTRACTOR';
    const title = isIssue ? 'GOODS ISSUE VOUCHER' : 'GOODS RECEIPT VOUCHER';

    doc.fontSize(14).fillColor('#1E40AF').text(title, { align: 'center' });
    doc.moveDown(1);

    doc.fillColor('#000000').fontSize(10);
    doc.text(`Voucher Number: ${txData.voucher_number}`, 50, 130);
    doc.text(`Date Issued: ${new Date(txData.transaction_date).toLocaleString()}`, 350, 130);
    if (txData.contract_number) {
        doc.text(`Contract No: ${txData.contract_number}`, 50, 150);
        doc.text(`Contractor: ${txData.contractor_name || 'N/A'}`, 350, 150);
    }

    let tableTop = 190;
    doc.rect(50, tableTop, 500, 20).fill('#E2E8F0');
    doc.fillColor('#0F172A').font('Helvetica-Bold');
    doc.text('Item Code', 60, tableTop + 5);
    doc.text('Description', 160, tableTop + 5);
    doc.text('Quantity', 380, tableTop + 5);
    doc.text('UOM', 480, tableTop + 5);

    doc.font('Helvetica').fillColor('#334155');
    doc.text(txData.item_code, 60, tableTop + 25);
    doc.text(txData.item_name, 160, tableTop + 25);
    doc.text(String(txData.quantity), 380, tableTop + 25);
    doc.text(txData.unit_of_measure, 480, tableTop + 25);

    if (txData.requisition_id) {
        tableTop = 270;
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(12).text('Workflow Decision History', 50, tableTop - 20);
        
        doc.rect(50, tableTop, 500, 20).fill('#E2E8F0');
        doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(10);
        doc.text('Action Taken', 60, tableTop + 5);
        doc.text('User / Department Name', 200, tableTop + 5);
        doc.text('Timestamp', 380, tableTop + 5);

        doc.font('Helvetica').fillColor('#334155');
        
        let rowY = tableTop + 25;
        doc.text('Requisition Created', 60, rowY);
        doc.text(txData.req_contractor_name || 'Contractor', 200, rowY);
        doc.text(new Date(txData.req_time).toLocaleString(), 380, rowY);
        
        rowY += 20;
        doc.text('Approved', 60, rowY);
        doc.text(txData.approver_name || 'Approver', 200, rowY);
        doc.text(new Date(txData.approval_time).toLocaleString(), 380, rowY);

        rowY += 20;
        doc.text('Material Issued', 60, rowY);
        doc.text(txData.issuer_name || 'Material Dept', 200, rowY);
        doc.text(new Date(txData.transaction_date).toLocaleString(), 380, rowY);
    }

    doc.end();
}
module.exports = { generateVoucherPDF };
