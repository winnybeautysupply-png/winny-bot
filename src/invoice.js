// ═══════════════════════════════════════════════════════════════
// Factura PDF — se genera cuando Winny CONFIRMA el pago de un pedido.
// Se manda a la clienta (su recibo) y a Winny (para que el empacador
// empaque guiándose por la factura). Usa pdfkit (sin navegador, ligero).
// ═══════════════════════════════════════════════════════════════
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import { config } from "./config.js";
import { logger } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, "assets", "logo.jpg");

// Paleta de marca de Winny
const PINK = "#D81B7A";
const GOLD = "#C9A227";
const DARK = "#222222";
const GRAY = "#777777";
const LIGHT = "#F4E6EF";

function rd(n) { return "RD$" + Number(n || 0).toLocaleString("en-US"); }

function parse_items(items) {
  let arr = items;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = []; } }
  return Array.isArray(arr) ? arr : [];
}

function items_subtotal(items) {
  return parse_items(items).reduce(
    (s, p) => s + (Number(p.precio_unitario_rd) || 0) * (Number(p.cantidad) || 1), 0);
}

// Genera la factura y devuelve { path, filename }. Promesa que resuelve al
// terminar de escribir el PDF en disco.
export function generate_invoice(order) {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(config.invoices_dir)) {
        fs.mkdirSync(config.invoices_dir, { recursive: true });
      }
      const filename = `factura-${order.id}-${Date.now()}.pdf`;
      const filepath = path.join(config.invoices_dir, filename);

      const items = parse_items(order.items);
      const subtotal = items_subtotal(items);
      const total = Number(order.total) || subtotal;
      const envio = total > subtotal ? total - subtotal : 0;

      const fecha = new Date().toLocaleDateString("es-DO", {
        timeZone: config.business.timezone, day: "2-digit", month: "2-digit", year: "numeric"
      });

      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const stream = fs.createWriteStream(filepath);
      doc.pipe(stream);

      const left = 50;
      const right = doc.page.width - 50; // 545
      const width = right - left;

      // ─── Encabezado: logo + nombre ───
      let y = 50;
      if (fs.existsSync(LOGO_PATH)) {
        try { doc.image(LOGO_PATH, left, y, { width: 70 }); } catch { /* sigue sin logo */ }
      }
      doc.fillColor(PINK).font("Helvetica-Bold").fontSize(22)
        .text("WINNY BEAUTY SUPPLY", left + 85, y + 6, { width: width - 85 });
      doc.fillColor(GRAY).font("Helvetica").fontSize(9)
        .text("Extensiones de cabello humano · Pelucas · Accesorios", left + 85, y + 32, { width: width - 85 });
      doc.fillColor(GRAY).fontSize(9)
        .text("WhatsApp: 849-248-9801  ·  Tel: 829-383-9433", left + 85, y + 45, { width: width - 85 });

      y += 90;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(2).strokeColor(GOLD).stroke();
      y += 14;

      // ─── Título FACTURA + número/fecha ───
      doc.fillColor(DARK).font("Helvetica-Bold").fontSize(16).text("FACTURA", left, y);
      doc.fillColor(GRAY).font("Helvetica").fontSize(10)
        .text(`No. de pedido: ${order.id}`, left, y, { width, align: "right" })
        .text(`Fecha: ${fecha}`, left, y + 14, { width, align: "right" });
      // Sello PAGADO (debajo del título, con fondo verde)
      doc.roundedRect(left, y + 22, 78, 18, 4).fillColor("#1B8A3A").fill();
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(11)
        .text("PAGADO", left, y + 26, { width: 78, align: "center" });
      y += 50;

      // ─── Datos de la clienta ───
      doc.roundedRect(left, y, width, 70, 6).fillColor(LIGHT).fill();
      doc.fillColor(PINK).font("Helvetica-Bold").fontSize(10).text("CLIENTA", left + 12, y + 10);
      doc.fillColor(DARK).font("Helvetica").fontSize(10)
        .text(`Nombre: ${order.customer_name || "—"}`, left + 12, y + 25, { width: width - 24 })
        .text(`Teléfono: +${order.phone}`, left + 12, y + 39, { width: width - 24 })
        .text(`Dirección de envío: ${order.delivery_address || "—"}`, left + 12, y + 53, { width: width - 24 });
      y += 86;

      // ─── Tabla de productos ───
      const cols = { prod: left + 8, cant: left + 300, precio: left + 360, imp: left + 450 };
      doc.rect(left, y, width, 22).fillColor(PINK).fill();
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(10);
      doc.text("Producto", cols.prod, y + 6);
      doc.text("Cant.", cols.cant, y + 6);
      doc.text("Precio", cols.precio, y + 6);
      doc.text("Importe", cols.imp, y + 6);
      y += 22;

      doc.font("Helvetica").fontSize(10).fillColor(DARK);
      for (const p of items) {
        const cant = Number(p.cantidad) || 1;
        const precio = Number(p.precio_unitario_rd) || 0;
        const importe = precio * cant;
        const nombre = `${p.nombre || "Producto"}${p.detalles ? ` (${p.detalles})` : ""}`;
        const rowH = Math.max(18, doc.heightOfString(nombre, { width: 285 }) + 6);
        doc.fillColor(DARK).text(nombre, cols.prod, y + 4, { width: 285 });
        doc.text(String(cant), cols.cant, y + 4);
        doc.text(rd(precio), cols.precio, y + 4);
        doc.text(rd(importe), cols.imp, y + 4);
        y += rowH;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor("#DDDDDD").stroke();
      }
      if (items.length === 0) {
        doc.fillColor(GRAY).text("(Sin productos registrados)", cols.prod, y + 4);
        y += 20;
      }
      y += 10;

      // ─── Totales ───
      const tLabelX = left + 300, tValX = left + 300;
      const tW = width - 300;
      function totalLine(label, value, opts = {}) {
        doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(opts.big ? 13 : 10)
          .fillColor(opts.color || DARK);
        doc.text(label, tLabelX, y, { width: 100 });
        doc.text(value, tValX, y, { width: tW, align: "right" });
        y += opts.big ? 22 : 16;
      }
      totalLine("Subtotal productos:", rd(subtotal));
      totalLine("Envío:", envio > 0 ? rd(envio) : "Por confirmar");
      doc.moveTo(tLabelX, y).lineTo(right, y).lineWidth(1).strokeColor(GOLD).stroke();
      y += 6;
      totalLine("TOTAL:", rd(total), { bold: true, big: true, color: PINK });

      // ─── Pie ───
      const footY = doc.page.height - 110;
      doc.moveTo(left, footY).lineTo(right, footY).lineWidth(1).strokeColor("#EEEEEE").stroke();
      doc.fillColor(GRAY).font("Helvetica").fontSize(8.5)
        .text("Sucursales:  Santo Domingo — Calle Ana Valverde No. 8, Mejoramiento Social   ·   " +
              "San Pedro de Macorís — frente a la Clínica de León, calle General Cabral, Placer Bonito",
              left, footY + 8, { width, align: "center" });
      doc.fillColor(PINK).font("Helvetica-Bold").fontSize(11)
        .text("¡Gracias por tu compra, belleza!", left, footY + 34, { width, align: "center" });
      doc.fillColor(GRAY).font("Helvetica").fontSize(8)
        .text("No se aceptan cambios ni devoluciones. Pedido preparado tras confirmación de pago.",
              left, footY + 52, { width, align: "center" });

      doc.end();

      stream.on("finish", () => {
        logger.info({ order_id: order.id, filepath }, "🧾 Factura PDF generada");
        resolve({ path: filepath, filename });
      });
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}
