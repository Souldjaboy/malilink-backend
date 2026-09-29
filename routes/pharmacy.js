"use strict";

const express = require("express");
const { allocateFefo } = require("../services/pharmacy-fefo");

module.exports = function createPharmacyRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();
  const companyOf = (req) => Number(getEffectiveCompanyId(req) || req.user?.company_id || 0);
  const tenantOf = (req) => req.user?.tenant_id || null;
  const perm = (key, action) => requirePermission ? requirePermission(key, action) : (_req, _res, next) => next();
  const text = (value, max = 255) => String(value ?? "").trim().slice(0, max);

  async function audit(client, req, action, entityType, entityId, metadata = {}) {
    await client.query(
      `INSERT INTO pharmacy_sensitive_audit
       (company_id, tenant_id, user_id, action, entity_type, entity_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [companyOf(req), tenantOf(req), req.user.id, action, entityType, entityId, JSON.stringify(metadata)]
    );
  }

  async function owned(client, table, id, companyId) {
    const allow = new Set(["products", "product_batches", "pharmacy_sites", "pharmacy_patients", "pharmacy_prescribers", "pharmacy_prescriptions", "warehouses", "cash_registers", "cash_sessions", "suppliers"]);
    if (!allow.has(table)) throw new Error("Table de validation interdite.");
    if (!id) return null;
    return (await client.query(`SELECT * FROM ${table} WHERE id=$1 AND company_id=$2`, [Number(id), companyId])).rows[0] || null;
  }

  router.get("/pharmacy/dashboard", authenticateToken, perm("pharmacie.rapports", "view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const [sales, stock, expiry, prescriptions, patients] = await Promise.all([
        pool.query(`SELECT COALESCE(SUM(s.total_amount),0)::numeric AS revenue, COUNT(*)::int AS tickets,
          COALESCE(SUM(si.quantity),0)::numeric AS units
          FROM sales s JOIN pharmacy_accounting_links pal ON pal.sale_id=s.id AND pal.company_id=s.company_id
          LEFT JOIN sale_items si ON si.sale_id=s.id AND si.company_id=s.company_id
          WHERE s.company_id=$1 AND s.created_at::date=CURRENT_DATE AND s.status NOT IN ('annulée','cancelled')`, [companyId]),
        pool.query(`SELECT COUNT(*)::int AS medicines, COALESCE(SUM(stock),0)::numeric AS units,
          COALESCE(SUM(stock*purchase_price),0)::numeric AS value,
          COUNT(*) FILTER (WHERE stock<=minimum_stock AND stock>0)::int AS low_stock,
          COUNT(*) FILTER (WHERE stock<=0)::int AS out_of_stock
          FROM products WHERE company_id=$1 AND product_kind IS NOT NULL AND is_active=TRUE`, [companyId]),
        pool.query(`SELECT COUNT(*) FILTER (WHERE pb.expiration_date<CURRENT_DATE)::int AS expired,
          COUNT(*) FILTER (WHERE pb.expiration_date BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '90 days')::int AS expiring
          FROM product_batches pb JOIN products p ON p.id=pb.product_id AND p.company_id=pb.company_id
          WHERE pb.company_id=$1 AND p.product_kind IS NOT NULL AND pb.quantity_remaining>0`, [companyId]),
        pool.query(`SELECT COUNT(*) FILTER (WHERE prescription_date=CURRENT_DATE)::int AS today,
          COUNT(*) FILTER (WHERE status IN ('received','pending','validated','partially_dispensed'))::int AS pending
          FROM pharmacy_prescriptions WHERE company_id=$1`, [companyId]),
        pool.query("SELECT COUNT(*)::int AS total FROM pharmacy_patients WHERE company_id=$1", [companyId]),
      ]);
      res.json({ sales_today: sales.rows[0], stock: stock.rows[0], expiry: expiry.rows[0], prescriptions: prescriptions.rows[0], patients: patients.rows[0] });
    } catch (error) {
      console.error("pharmacy dashboard:", error);
      res.status(500).json({ error: "Erreur tableau de bord pharmacie." });
    }
  });

  router.get("/pharmacy/medicines", authenticateToken, perm("pharmacie.medicaments", "view"), async (req, res) => {
    try {
      const q = `%${text(req.query.q, 120)}%`;
      const { rows } = await pool.query(`SELECT p.*,
        COALESCE(SUM(pb.quantity_remaining) FILTER (WHERE pb.status IN ('active','actif')),0)::numeric AS batch_stock
        FROM products p LEFT JOIN product_batches pb ON pb.product_id=p.id AND pb.company_id=p.company_id
        WHERE p.company_id=$1 AND p.product_kind IS NOT NULL
          AND ($2='%%' OR p.name ILIKE $2 OR p.generic_name ILIKE $2 OR p.active_ingredient ILIKE $2 OR p.barcode ILIKE $2)
        GROUP BY p.id ORDER BY p.name LIMIT 500`, [companyOf(req), q]);
      res.json(rows);
    } catch (error) { res.status(500).json({ error: "Erreur catalogue médicaments." }); }
  });

  router.post("/pharmacy/medicines", authenticateToken, perm("pharmacie.medicaments", "create"), async (req, res) => {
    try {
      const b = req.body || {};
      if (!text(b.name)) return res.status(400).json({ error: "Nom du médicament obligatoire." });
      const { rows } = await pool.query(`INSERT INTO products
        (company_id,name,reference,barcode,category,product_kind,generic_name,active_ingredient,dosage,dosage_form,
         packaging,manufacturer,therapeutic_family,supplier_reference,purchase_price,sale_price,tax_rate,minimum_stock,
         prescription_required,sensitive_product,storage_temperature,image_url,leaflet_url,batch_tracking_enabled,
         expiration_tracking_enabled,stock,is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,TRUE,TRUE,0,$24)
        RETURNING *`, [companyOf(req),text(b.name),text(b.reference),text(b.barcode),text(b.category),text(b.product_kind)||"medicament",
        text(b.generic_name||b.dci),text(b.active_ingredient||b.dci),text(b.dosage),text(b.dosage_form),text(b.packaging),
        text(b.manufacturer),text(b.therapeutic_family),text(b.supplier_reference),Number(b.purchase_price||0),
        Number(b.sale_price||0),Number(b.tax_rate||0),Number(b.minimum_stock||0),b.prescription_required===true,
        b.sensitive_product===true,text(b.storage_temperature),text(b.image_url,1000),text(b.leaflet_url,1000),b.is_active!==false]);
      res.status(201).json(rows[0]);
    } catch (error) { console.error("medicine create:", error); res.status(500).json({ error: "Erreur création médicament." }); }
  });

  router.get("/pharmacy/batches", authenticateToken, perm("pharmacie.lots", "view"), async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT pb.*,p.name AS product_name,ps.name AS site_name
        FROM product_batches pb JOIN products p ON p.id=pb.product_id AND p.company_id=pb.company_id
        LEFT JOIN pharmacy_sites ps ON ps.id=pb.pharmacy_site_id AND ps.company_id=pb.company_id
        WHERE pb.company_id=$1 AND p.product_kind IS NOT NULL ORDER BY pb.expiration_date,p.name`, [companyOf(req)]);
      res.json(rows);
    } catch { res.status(500).json({ error: "Erreur lecture lots." }); }
  });

  router.post("/pharmacy/medicines/:id/batches", authenticateToken, perm("pharmacie.lots", "create"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req), b = req.body || {}, quantity = Number(b.quantity || 0);
      if (!text(b.lot_number) || !(quantity > 0) || !b.expiration_date) return res.status(400).json({ error: "Lot, quantité et péremption obligatoires." });
      await client.query("BEGIN");
      const product = await owned(client,"products",req.params.id,companyId);
      if (!product || !product.product_kind) throw Object.assign(new Error("Médicament introuvable."), { statusCode: 404 });
      if (b.site_id && !(await owned(client,"pharmacy_sites",b.site_id,companyId))) throw Object.assign(new Error("Site invalide."), { statusCode: 400 });
      if (b.supplier_id && !(await owned(client,"suppliers",b.supplier_id,companyId))) throw Object.assign(new Error("Fournisseur invalide."), { statusCode: 400 });
      const batch = (await client.query(`INSERT INTO product_batches
        (company_id,product_id,lot_number,quantity_initial,quantity_remaining,manufacturing_date,expiration_date,
         purchase_price,sale_price,supplier_id,received_at,pharmacy_site_id,status)
        VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP,$10,'active') RETURNING *`,
        [companyId,product.id,text(b.lot_number),quantity,b.manufacturing_date||null,b.expiration_date,
         Number(b.purchase_price||0),Number(b.sale_price||0),b.supplier_id||null,b.site_id||null])).rows[0];
      await client.query("UPDATE products SET stock=COALESCE(stock,0)+$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND company_id=$3", [quantity,product.id,companyId]);
      await client.query(`INSERT INTO pharmacy_stock_events
        (company_id,tenant_id,site_id,product_id,batch_id,event_type,quantity,source_type,source_id,created_by)
        VALUES ($1,$2,$3,$4,$5,'receipt',$6,'batch',$5,$7)`, [companyId,tenantOf(req),b.site_id||null,product.id,batch.id,quantity,req.user.id]);
      await client.query("COMMIT"); res.status(201).json(batch);
    } catch (error) { await client.query("ROLLBACK"); res.status(error.statusCode||500).json({ error:error.message||"Erreur réception lot." }); }
    finally { client.release(); }
  });

  router.get("/pharmacy/patients", authenticateToken, perm("pharmacie.patients", "view"), async (req, res) => {
    const client = await pool.connect();
    try { const rows=(await client.query("SELECT * FROM pharmacy_patients WHERE company_id=$1 ORDER BY id DESC LIMIT 500",[companyOf(req)])).rows; await audit(client,req,"list","patient",null,{count:rows.length}); res.json(rows); }
    catch { res.status(500).json({error:"Erreur lecture patients."}); } finally { client.release(); }
  });

  router.post("/pharmacy/patients", authenticateToken, perm("pharmacie.patients", "create"), async (req, res) => {
    const client=await pool.connect(); try { const b=req.body||{}; if(!text(b.fullname))return res.status(400).json({error:"Nom du patient obligatoire."});
      await client.query("BEGIN"); const number=text(b.patient_number)||`PAT-${companyOf(req)}-${Date.now()}`;
      const row=(await client.query(`INSERT INTO pharmacy_patients
        (company_id,tenant_id,patient_number,fullname,birth_date,sex,phone,address,declared_allergies,professional_notes,communication_preferences,consent_data,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[companyOf(req),tenantOf(req),number,text(b.fullname),b.birth_date||null,text(b.sex),text(b.phone),text(b.address,1000),text(b.declared_allergies,2000),text(b.professional_notes,4000),JSON.stringify(b.communication_preferences||{}),JSON.stringify(b.consent_data||{}),req.user.id])).rows[0];
      await audit(client,req,"create","patient",row.id); await client.query("COMMIT"); res.status(201).json(row);
    } catch(error){await client.query("ROLLBACK");res.status(500).json({error:"Erreur création patient."});} finally{client.release();}
  });

  router.get("/pharmacy/prescriptions", authenticateToken, perm("pharmacie.ordonnances", "view"), async(req,res)=>{
    const client=await pool.connect();try{const rows=(await client.query(`SELECT pr.*,pa.fullname AS patient_name,pp.fullname AS prescriber_name,
      COALESCE(json_agg(pi ORDER BY pi.id) FILTER (WHERE pi.id IS NOT NULL),'[]') AS items
      FROM pharmacy_prescriptions pr LEFT JOIN pharmacy_patients pa ON pa.id=pr.patient_id AND pa.company_id=pr.company_id
      LEFT JOIN pharmacy_prescribers pp ON pp.id=pr.prescriber_id AND pp.company_id=pr.company_id
      LEFT JOIN pharmacy_prescription_items pi ON pi.prescription_id=pr.id AND pi.company_id=pr.company_id
      WHERE pr.company_id=$1 GROUP BY pr.id,pa.fullname,pp.fullname ORDER BY pr.id DESC`,[companyOf(req)])).rows;
      await audit(client,req,"list","prescription",null,{count:rows.length});res.json(rows);}catch{res.status(500).json({error:"Erreur lecture ordonnances."});}finally{client.release();}
  });

  router.post("/pharmacy/prescriptions", authenticateToken, perm("pharmacie.ordonnances", "create"), async(req,res)=>{
    const client=await pool.connect();try{const companyId=companyOf(req),b=req.body||{},items=Array.isArray(b.items)?b.items:[];await client.query("BEGIN");
      if(b.patient_id&&!(await owned(client,"pharmacy_patients",b.patient_id,companyId)))throw Object.assign(new Error("Patient invalide."),{statusCode:400});
      if(b.prescriber_id&&!(await owned(client,"pharmacy_prescribers",b.prescriber_id,companyId)))throw Object.assign(new Error("Prescripteur invalide."),{statusCode:400});
      if(b.site_id&&!(await owned(client,"pharmacy_sites",b.site_id,companyId)))throw Object.assign(new Error("Site invalide."),{statusCode:400});
      const reference=text(b.reference)||`ORD-${companyId}-${Date.now()}`;
      const row=(await client.query(`INSERT INTO pharmacy_prescriptions
        (company_id,tenant_id,site_id,patient_id,prescriber_id,prescription_date,reference,private_file_key,status,notes,created_by)
        VALUES ($1,$2,$3,$4,$5,COALESCE($6::date,CURRENT_DATE),$7,$8,$9,$10,$11) RETURNING *`,[companyId,tenantOf(req),b.site_id||null,b.patient_id||null,b.prescriber_id||null,b.prescription_date||null,reference,text(b.private_file_key,1000),"received",text(b.notes,4000),req.user.id])).rows[0];
      for(const item of items){if(item.product_id){const p=await owned(client,"products",item.product_id,companyId);if(!p||!p.product_kind)throw Object.assign(new Error("Médicament invalide."),{statusCode:400});}
        await client.query(`INSERT INTO pharmacy_prescription_items
          (company_id,prescription_id,product_id,medication_text,dosage,quantity,directions,duration)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[companyId,row.id,item.product_id||null,text(item.medication_text),text(item.dosage),Number(item.quantity||0),text(item.directions,1000),text(item.duration)]);}
      await audit(client,req,"create","prescription",row.id);await client.query("COMMIT");res.status(201).json(row);
    }catch(error){await client.query("ROLLBACK");res.status(error.statusCode||500).json({error:error.message||"Erreur création ordonnance."});}finally{client.release();}
  });

  router.post("/pharmacy/sales", authenticateToken, perm("pharmacie.ventes", "create"), async(req,res)=>{
    const client=await pool.connect();try{const companyId=companyOf(req),b=req.body||{},items=Array.isArray(b.items)?b.items:[];if(!items.length)return res.status(400).json({error:"Vente sans article."});await client.query("BEGIN");
      for(const [table,id,label] of [["pharmacy_sites",b.site_id,"Site"],["warehouses",b.warehouse_id,"Entrepôt"],["cash_registers",b.cash_register_id,"Caisse"],["cash_sessions",b.cash_session_id,"Session de caisse"]])if(id&&!(await owned(client,table,id,companyId)))throw Object.assign(new Error(`${label} invalide.`),{statusCode:400});
      const prepared=[];let subtotal=0;for(const item of items){const product=await owned(client,"products",item.product_id,companyId);if(!product||!product.product_kind||product.is_active===false)throw Object.assign(new Error("Médicament introuvable."),{statusCode:404});const quantity=Number(item.quantity||0);if(!(quantity>0))throw Object.assign(new Error("Quantité invalide."),{statusCode:400});const batches=(await client.query(`SELECT * FROM product_batches WHERE product_id=$1 AND company_id=$2 AND ($3::int IS NULL OR pharmacy_site_id=$3) AND quantity_remaining>0 FOR UPDATE`,[product.id,companyId,b.site_id||null])).rows;const allocations=allocateFefo(batches,quantity,new Date());const unitPrice=Number(item.unit_price??product.sale_price??0);subtotal+=quantity*unitPrice;prepared.push({product,quantity,unitPrice,allocations});}
      const discount=Math.max(0,Number(b.discount_amount||0)),total=Math.max(0,subtotal-discount),saleNumber=`PHA-${companyId}-${Date.now()}`;
      const sale=(await client.query(`INSERT INTO sales
        (company_id,warehouse_id,cash_register_id,cash_session_id,sale_number,customer_name,customer_phone,subtotal,discount_amount,total_amount,payment_method,payment_status,status,created_by,created_by_name,created_by_role,amount_paid,remaining_amount)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'validée',$13,$14,$15,$16,$17) RETURNING *`,[companyId,b.warehouse_id||null,b.cash_register_id||null,b.cash_session_id||null,saleNumber,text(b.customer_name),text(b.customer_phone),subtotal,discount,total,text(b.payment_method)||"Espèces",text(b.payment_status)||"payé",req.user.id,req.user.email||"",req.user.role||"",Number(b.amount_paid??total),Math.max(0,total-Number(b.amount_paid??total))])).rows[0];
      for(const line of prepared){const itemRow=(await client.query(`INSERT INTO sale_items
        (sale_id,company_id,product_id,product_reference,product_name,barcode,quantity,unit_price,sale_price,purchase_price,total_price,warehouse_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11) RETURNING *`,[sale.id,companyId,line.product.id,line.product.reference||"",line.product.name,line.product.barcode||"",line.quantity,line.unitPrice,Number(line.allocations[0]?.purchase_price||line.product.purchase_price||0),line.quantity*line.unitPrice,b.warehouse_id||null])).rows[0];
        for(const allocation of line.allocations){await client.query("UPDATE product_batches SET quantity_remaining=quantity_remaining-$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND company_id=$3",[allocation.quantity,allocation.batch_id,companyId]);await client.query(`INSERT INTO pharmacy_sale_lot_allocations
          (company_id,tenant_id,sale_id,sale_item_id,product_id,batch_id,lot_number,expiration_date,quantity)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[companyId,tenantOf(req),sale.id,itemRow.id,line.product.id,allocation.batch_id,allocation.lot_number,allocation.expiration_date,allocation.quantity]);await client.query(`INSERT INTO pharmacy_stock_events
          (company_id,tenant_id,site_id,product_id,batch_id,event_type,quantity,source_type,source_id,created_by)
          VALUES ($1,$2,$3,$4,$5,'sale',$6,'sale',$7,$8)`,[companyId,tenantOf(req),b.site_id||null,line.product.id,allocation.batch_id,-allocation.quantity,sale.id,req.user.id]);}
        await client.query("UPDATE products SET stock=GREATEST(0,COALESCE(stock,0)-$1),updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND company_id=$3",[line.quantity,line.product.id,companyId]);}
      const receiptNumber=`REC-PHA-${companyId}-${Date.now()}`;const receipt=(await client.query(`INSERT INTO receipts
        (company_id,sale_id,receipt_number,receipt_data,total_amount,payment_method,payment_status,status,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8) RETURNING *`,[companyId,sale.id,receiptNumber,JSON.stringify({source:"pharmacie",sale_number:saleNumber}),total,text(b.payment_method)||"Espèces",text(b.payment_status)||"payé",req.user.id])).rows[0];
      await client.query(`INSERT INTO pharmacy_accounting_links (company_id,sale_id,payment_source,amount,bridge_status)
        VALUES ($1,$2,'pharmacy_sale',$3,'pending') ON CONFLICT (company_id,sale_id,payment_source) DO NOTHING`,[companyId,sale.id,total]);
      await client.query("COMMIT");res.status(201).json({sale,receipt,allocations:prepared.flatMap((x)=>x.allocations),accounting_bridge_status:"pending"});
    }catch(error){await client.query("ROLLBACK");res.status(error.statusCode||500).json({error:error.message==="INSUFFICIENT_FEFO_STOCK"?"Stock FEFO vendable insuffisant.":error.message||"Erreur vente pharmacie.",available:error.available});}finally{client.release();}
  });

  router.get("/pharmacy/sites", authenticateToken, perm("pharmacie.sites", "view"), async(req,res)=>{try{res.json((await pool.query("SELECT * FROM pharmacy_sites WHERE company_id=$1 ORDER BY name",[companyOf(req)])).rows);}catch{res.status(500).json({error:"Erreur lecture sites."});}});
  router.get("/pharmacy/safety/status", authenticateToken, perm("pharmacie.parametres", "view"), async(req,res)=>{try{const row=(await pool.query("SELECT safety_provider,safety_integration_enabled FROM pharmacy_settings WHERE company_id=$1",[companyOf(req)])).rows[0]||{};res.json({enabled:row.safety_integration_enabled===true,provider:row.safety_provider||null,medical_decision_support:false,message:"Aucune base pharmacologique fiable/licenciée n’est configurée. Aucune alerte médicale n’est générée."});}catch{res.status(500).json({error:"Erreur paramètres pharmacie."});}});

  return router;
};
