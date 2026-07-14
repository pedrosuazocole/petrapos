'use strict';
const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const helmet     = require('helmet');
const path       = require('path');
const fs         = require('fs');
const { v4: uuid } = require('uuid');
const initSqlJs  = require('sql.js');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'metricpos_secret_2026_hn';
const DB_FILE    = path.join(__dirname, 'data', 'metricpos.db');

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db; let SQL;

async function initDB() {
  if (!fs.existsSync(path.join(__dirname,'data'))) fs.mkdirSync(path.join(__dirname,'data'));
  SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) { db=new SQL.Database(fs.readFileSync(DB_FILE)); console.log('📂 DB cargada'); }
  else { db=new SQL.Database(); console.log('🆕 DB nueva'); }
  createSchema(); seedData(); saveDB();
}
function saveDB() { fs.writeFileSync(DB_FILE, Buffer.from(db.export())); }
setInterval(saveDB, 30000);
function run(sql,params=[]){ db.run(sql,params); }
function all(sql,params=[]){ const s=db.prepare(sql),r=[]; s.bind(params); while(s.step())r.push(s.getAsObject()); s.free(); return r; }
function get(sql,params=[]){ return all(sql,params)[0]||null; }

function createSchema(){
  db.run(`PRAGMA journal_mode=WAL`);
  db.run(`CREATE TABLE IF NOT EXISTS sucursales(id TEXT PRIMARY KEY,nombre TEXT,direccion TEXT,telefono TEXT,rtn TEXT,cai TEXT,serie TEXT,rango_ini TEXT,rango_fin TEXT,fecha_limite TEXT,logo TEXT,activa INTEGER DEFAULT 1,creado TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS usuarios(id TEXT PRIMARY KEY,nombre TEXT,username TEXT UNIQUE,password TEXT,rol TEXT CHECK(rol IN('admin','supervisor','cajero')),sucursal_id TEXT,activo INTEGER DEFAULT 1,creado TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS categorias(id INTEGER PRIMARY KEY AUTOINCREMENT,nombre TEXT UNIQUE,activa INTEGER DEFAULT 1)`);
  db.run(`CREATE TABLE IF NOT EXISTS productos(id TEXT PRIMARY KEY,codigo TEXT UNIQUE,nombre TEXT,categoria TEXT,precio_venta REAL,costo REAL DEFAULT 0,gravado INTEGER DEFAULT 1,activo INTEGER DEFAULT 1,creado TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS inventario(id INTEGER PRIMARY KEY AUTOINCREMENT,producto_id TEXT,sucursal_id TEXT,stock INTEGER DEFAULT 0,stock_min INTEGER DEFAULT 0,UNIQUE(producto_id,sucursal_id))`);
  db.run(`CREATE TABLE IF NOT EXISTS kardex(id INTEGER PRIMARY KEY AUTOINCREMENT,producto_id TEXT,sucursal_id TEXT,tipo TEXT,cantidad INTEGER,costo_unit REAL DEFAULT 0,precio_unit REAL DEFAULT 0,saldo_stock INTEGER,referencia TEXT,motivo TEXT,usuario_id TEXT,fecha TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS clientes(id TEXT PRIMARY KEY,nombre TEXT,rtn TEXT,direccion TEXT,telefono TEXT,email TEXT,limite_credito REAL DEFAULT 0,saldo REAL DEFAULT 0,activo INTEGER DEFAULT 1,creado TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS proveedores(id TEXT PRIMARY KEY,nombre TEXT,rtn TEXT,direccion TEXT,telefono TEXT,email TEXT,contacto TEXT,limite_credito REAL DEFAULT 0,saldo REAL DEFAULT 0,activo INTEGER DEFAULT 1,creado TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS ventas(id TEXT PRIMARY KEY,numero_factura TEXT,sucursal_id TEXT,cliente_id TEXT,usuario_id TEXT,subtotal REAL,descuento REAL DEFAULT 0,importe_gravado REAL DEFAULT 0,importe_exento REAL DEFAULT 0,importe_exonerado REAL DEFAULT 0,isv15 REAL DEFAULT 0,isv18 REAL DEFAULT 0,total REAL,exonerado INTEGER DEFAULT 0,orden_compra_exenta TEXT,constancia_registro TEXT,identificativo_sag TEXT,estado TEXT DEFAULT 'emitida',fecha TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ventas_suc ON ventas(sucursal_id)`);
  db.run(`CREATE TABLE IF NOT EXISTS venta_items(id INTEGER PRIMARY KEY AUTOINCREMENT,venta_id TEXT,producto_id TEXT,producto_codigo TEXT,producto_nombre TEXT,producto_categoria TEXT,cantidad INTEGER,precio_unit REAL,costo_unit REAL DEFAULT 0,subtotal REAL)`);
  db.run(`CREATE TABLE IF NOT EXISTS devoluciones(id TEXT PRIMARY KEY,venta_id TEXT,sucursal_id TEXT,usuario_id TEXT,motivo TEXT,total REAL DEFAULT 0,fecha TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS devolucion_items(id INTEGER PRIMARY KEY AUTOINCREMENT,devolucion_id TEXT,producto_id TEXT,cantidad INTEGER,precio_unit REAL,subtotal REAL)`);
  db.run(`CREATE TABLE IF NOT EXISTS compras(id TEXT PRIMARY KEY,proveedor_id TEXT,sucursal_id TEXT,usuario_id TEXT,numero_doc TEXT,subtotal REAL,isv REAL DEFAULT 0,total REAL,estado TEXT DEFAULT 'pendiente',notas TEXT,fecha TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS compra_items(id INTEGER PRIMARY KEY AUTOINCREMENT,compra_id TEXT,producto_id TEXT,producto_nombre TEXT,cantidad INTEGER,costo_unit REAL,subtotal REAL,cantidad_recibida INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS cxc(id TEXT PRIMARY KEY,cliente_id TEXT,sucursal_id TEXT,referencia TEXT,monto REAL,saldo REAL,fecha TEXT,vencimiento TEXT,estado TEXT DEFAULT 'pendiente',creado TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS cxp(id TEXT PRIMARY KEY,proveedor_id TEXT,sucursal_id TEXT,referencia TEXT,monto REAL,saldo REAL,fecha TEXT,vencimiento TEXT,estado TEXT DEFAULT 'pendiente',creado TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS pagos_cxc(id INTEGER PRIMARY KEY AUTOINCREMENT,cxc_id TEXT,monto REAL,usuario_id TEXT,fecha TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS pagos_cxp(id INTEGER PRIMARY KEY AUTOINCREMENT,cxp_id TEXT,monto REAL,usuario_id TEXT,fecha TEXT DEFAULT(datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS config(clave TEXT PRIMARY KEY,valor TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS sync_log(id INTEGER PRIMARY KEY AUTOINCREMENT,sucursal_id TEXT,tabla TEXT,operacion TEXT,registro_id TEXT,datos TEXT,fecha TEXT DEFAULT(datetime('now')),sincronizado INTEGER DEFAULT 0)`);
  console.log('✅ Esquema OK');
}

function seedData(){
  if(get(`SELECT id FROM sucursales LIMIT 1`)) return;
  const sid=uuid();
  db.run(`INSERT INTO sucursales(id,nombre,direccion,telefono,rtn,cai,serie,rango_ini,rango_fin,fecha_limite)VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [sid,'Casa Matriz','Tegucigalpa, Honduras','2234-5678','08011985024566','6542H9-B3C8BC-7442C5-5BD634-5684F5-C0','002-001-01','002-001-01-00000001','002-001-01-00000050','2026-12-31']);
  const hash=bcrypt.hashSync('admin123',10);
  db.run(`INSERT INTO usuarios(id,nombre,username,password,rol,sucursal_id)VALUES(?,?,?,?,?,?)`,
    [uuid(),'Administrador','admin',hash,'admin',sid]);
  const prods=[
    [uuid(),'PROD001','Arroz Premium 5lb','Alimentos',85,55,1],
    [uuid(),'PROD002','Aceite Vegetal 1L','Alimentos',65,40,1],
    [uuid(),'PROD003','Leche Entera 1L','Lácteos',35,22,1],
    [uuid(),'PROD004','Pan Blanco','Panadería',25,15,1],
    [uuid(),'PROD005','Detergente 1kg','Limpieza',95,60,1],
  ];
  for(const p of prods){
    db.run(`INSERT OR IGNORE INTO productos(id,codigo,nombre,categoria,precio_venta,costo,gravado)VALUES(?,?,?,?,?,?,?)`,p);
    db.run(`INSERT OR IGNORE INTO inventario(producto_id,sucursal_id,stock,stock_min)VALUES(?,?,50,10)`,[p[0],sid]);
  }
  db.run(`INSERT INTO clientes(id,nombre,rtn)VALUES(?,?,?)`,[uuid(),'Consumidor Final','']);
  db.run(`INSERT INTO clientes(id,nombre,rtn,telefono,limite_credito)VALUES(?,?,?,?,?)`,[uuid(),'Empresa ABC S.A.','08011990123456','2240-1234',50000]);
  db.run(`INSERT INTO proveedores(id,nombre,rtn,telefono,email)VALUES(?,?,?,?,?)`,[uuid(),'Distribuidora Nacional','08019880001234','2211-0000','ventas@dist.hn']);
  ['Alimentos','Lácteos','Panadería','Limpieza','Bebidas','Varios'].forEach(c=>db.run(`INSERT OR IGNORE INTO categorias(nombre)VALUES(?)`,[c]));
  saveDB();
  console.log('✅ Datos iniciales — admin/admin123');
}

function auth(roles=[]){
  return(req,res,next)=>{
    const t=req.headers.authorization?.split(' ')[1];
    if(!t)return res.status(401).json({error:'Token requerido'});
    try{
      const p=jwt.verify(t,JWT_SECRET);
      req.user=p;
      if(roles.length&&!roles.includes(p.rol))return res.status(403).json({error:'Sin permiso'});
      next();
    }catch{return res.status(401).json({error:'Token inválido'});}
  };
}

function ajustarStock(pid,sid,qty,tipo,ref,motivo,uid,costo=0,precio=0){
  const inv=get(`SELECT stock FROM inventario WHERE producto_id=? AND sucursal_id=?`,[pid,sid]);
  const cur=inv?inv.stock:0;
  const nuevo=(tipo==='entrada'||tipo==='compra')?cur+qty:Math.max(0,cur-qty);
  db.run(`INSERT OR IGNORE INTO inventario(producto_id,sucursal_id,stock,stock_min)VALUES(?,?,0,0)`,[pid,sid]);
  db.run(`UPDATE inventario SET stock=? WHERE producto_id=? AND sucursal_id=?`,[nuevo,pid,sid]);
  db.run(`INSERT INTO kardex(producto_id,sucursal_id,tipo,cantidad,costo_unit,precio_unit,saldo_stock,referencia,motivo,usuario_id)VALUES(?,?,?,?,?,?,?,?,?,?)`,[pid,sid,tipo,qty,costo,precio,nuevo,ref,motivo,uid]);
  return nuevo;
}

// ── AUTH ──
app.post('/api/auth/login',(req,res)=>{
  const{username,password,sucursal_id}=req.body;
  const u=get(`SELECT * FROM usuarios WHERE username=? AND activo=1`,[username]);
  if(!u||!bcrypt.compareSync(password,u.password))return res.status(401).json({error:'Usuario o contraseña incorrectos'});
  const sid=u.rol==='admin'?(sucursal_id||u.sucursal_id):u.sucursal_id;
  const suc=get(`SELECT * FROM sucursales WHERE id=?`,[sid]);
  const token=jwt.sign({id:u.id,nombre:u.nombre,username:u.username,rol:u.rol,sucursal_id:sid},JWT_SECRET,{expiresIn:'12h'});
  res.json({token,user:{id:u.id,nombre:u.nombre,username:u.username,rol:u.rol,sucursal_id:sid},sucursal:suc});
});
app.get('/api/auth/me',auth(),(req,res)=>res.json(get(`SELECT id,nombre,username,rol,sucursal_id FROM usuarios WHERE id=?`,[req.user.id])));

// ── USUARIOS ──
app.get('/api/usuarios',auth(['admin']),(req,res)=>res.json(all(`SELECT u.id,u.nombre,u.username,u.rol,u.activo,u.creado,s.nombre as sucursal_nombre FROM usuarios u LEFT JOIN sucursales s ON s.id=u.sucursal_id`)));
app.post('/api/usuarios',auth(['admin']),(req,res)=>{
  const{nombre,username,password,rol,sucursal_id}=req.body;
  if(get(`SELECT id FROM usuarios WHERE username=?`,[username]))return res.status(400).json({error:'Username ya existe'});
  const id=uuid(); run(`INSERT INTO usuarios(id,nombre,username,password,rol,sucursal_id)VALUES(?,?,?,?,?,?)`,[id,nombre,username,bcrypt.hashSync(password,10),rol,sucursal_id]); saveDB(); res.json({id});
});
app.put('/api/usuarios/:id',auth(['admin']),(req,res)=>{
  const{nombre,rol,sucursal_id,activo,password}=req.body;
  if(password)run(`UPDATE usuarios SET nombre=?,rol=?,sucursal_id=?,activo=?,password=? WHERE id=?`,[nombre,rol,sucursal_id,activo,bcrypt.hashSync(password,10),req.params.id]);
  else run(`UPDATE usuarios SET nombre=?,rol=?,sucursal_id=?,activo=? WHERE id=?`,[nombre,rol,sucursal_id,activo,req.params.id]);
  saveDB(); res.json({ok:1});
});

// ── SUCURSALES ──
app.get('/api/sucursales',(req,res)=>res.json(all(`SELECT id,nombre FROM sucursales WHERE activa=1`)));
app.post('/api/sucursales',auth(['admin']),(req,res)=>{
  const{nombre,direccion,telefono,rtn,cai,serie,rango_ini,rango_fin,fecha_limite}=req.body;
  const id=uuid(); run(`INSERT INTO sucursales(id,nombre,direccion,telefono,rtn,cai,serie,rango_ini,rango_fin,fecha_limite)VALUES(?,?,?,?,?,?,?,?,?,?)`,[id,nombre,direccion,telefono,rtn,cai,serie,rango_ini,rango_fin,fecha_limite]); saveDB(); res.json({id});
});
app.put('/api/sucursales/:id',auth(['admin']),(req,res)=>{
  const{nombre,direccion,telefono,rtn,cai,serie,rango_ini,rango_fin,fecha_limite,logo}=req.body;
  run(`UPDATE sucursales SET nombre=?,direccion=?,telefono=?,rtn=?,cai=?,serie=?,rango_ini=?,rango_fin=?,fecha_limite=?,logo=? WHERE id=?`,[nombre,direccion,telefono,rtn,cai,serie,rango_ini,rango_fin,fecha_limite,logo,req.params.id]); saveDB(); res.json({ok:1});
});

// ── PRODUCTOS ──
app.get('/api/productos',auth(),(req,res)=>{
  const suc=req.query.sucursal_id||req.user.sucursal_id;
  const q=req.query.q;
  let sql=`SELECT p.*,COALESCE(i.stock,0) as stock,COALESCE(i.stock_min,0) as stock_min FROM productos p LEFT JOIN inventario i ON i.producto_id=p.id AND i.sucursal_id=? WHERE p.activo=1`;
  const params=[suc];
  if(q){sql+=` AND (p.nombre LIKE ? OR p.codigo LIKE ?)`; params.push(`%${q}%`,`%${q}%`);}
  sql+=` ORDER BY p.nombre`;
  res.json(all(sql,params));
});
app.get('/api/productos/barcode/:codigo',auth(),(req,res)=>{
  const suc=req.query.sucursal_id||req.user.sucursal_id;
  const p=get(`SELECT p.*,COALESCE(i.stock,0) as stock FROM productos p LEFT JOIN inventario i ON i.producto_id=p.id AND i.sucursal_id=? WHERE p.codigo=? AND p.activo=1`,[suc,req.params.codigo]);
  if(!p)return res.status(404).json({error:'No encontrado'}); res.json(p);
});
app.post('/api/productos',auth(['admin','supervisor']),(req,res)=>{
  const{codigo,nombre,categoria,precio_venta,costo,gravado}=req.body;
  if(get(`SELECT id FROM productos WHERE codigo=?`,[codigo]))return res.status(400).json({error:'Código ya existe'});
  const id=uuid();
  run(`INSERT INTO productos(id,codigo,nombre,categoria,precio_venta,costo,gravado)VALUES(?,?,?,?,?,?,?)`,[id,codigo,nombre,categoria,precio_venta,costo||0,gravado!==false?1:0]);
  all(`SELECT id FROM sucursales WHERE activa=1`).forEach(s=>run(`INSERT OR IGNORE INTO inventario(producto_id,sucursal_id,stock,stock_min)VALUES(?,?,0,0)`,[id,s.id]));
  saveDB(); res.json({id});
});
app.put('/api/productos/:id',auth(['admin','supervisor']),(req,res)=>{
  const{nombre,categoria,precio_venta,costo,gravado}=req.body;
  run(`UPDATE productos SET nombre=?,categoria=?,precio_venta=?,costo=?,gravado=? WHERE id=?`,[nombre,categoria,precio_venta,costo||0,gravado!==false?1:0,req.params.id]); saveDB(); res.json({ok:1});
});
app.delete('/api/productos/:id',auth(['admin']),(req,res)=>{ run(`UPDATE productos SET activo=0 WHERE id=?`,[req.params.id]); saveDB(); res.json({ok:1}); });

// ── INVENTARIO/KARDEX ──
app.get('/api/inventario',auth(),(req,res)=>{
  const suc=req.query.sucursal_id||req.user.sucursal_id;
  res.json(all(`SELECT p.id,p.codigo,p.nombre,p.categoria,p.precio_venta,p.costo,COALESCE(i.stock,0)as stock,COALESCE(i.stock_min,0)as stock_min FROM productos p LEFT JOIN inventario i ON i.producto_id=p.id AND i.sucursal_id=? WHERE p.activo=1 ORDER BY p.categoria,p.nombre`,[suc]));
});
app.post('/api/inventario/ajuste',auth(['admin','supervisor']),(req,res)=>{
  const{producto_id,sucursal_id,tipo,cantidad,motivo,costo}=req.body;
  const suc=sucursal_id||req.user.sucursal_id;
  const nuevo=ajustarStock(producto_id,suc,cantidad,tipo,'AJUSTE',motivo,req.user.id,costo||0); saveDB(); res.json({stock:nuevo});
});
app.put('/api/inventario/stock_min',auth(['admin','supervisor']),(req,res)=>{
  const{producto_id,sucursal_id,stock_min}=req.body;
  run(`UPDATE inventario SET stock_min=? WHERE producto_id=? AND sucursal_id=?`,[stock_min,producto_id,sucursal_id||req.user.sucursal_id]); saveDB(); res.json({ok:1});
});
app.get('/api/kardex/:pid',auth(),(req,res)=>{
  const suc=req.query.sucursal_id||req.user.sucursal_id;
  res.json(all(`SELECT k.*,u.nombre as usuario_nombre FROM kardex k LEFT JOIN usuarios u ON u.id=k.usuario_id WHERE k.producto_id=? AND k.sucursal_id=? ORDER BY k.fecha DESC LIMIT 200`,[req.params.pid,suc]));
});

// ── CLIENTES ──
app.get('/api/clientes',auth(),(req,res)=>res.json(all(`SELECT * FROM clientes WHERE activo=1 ORDER BY nombre`)));
app.post('/api/clientes',auth(['admin','supervisor','cajero']),(req,res)=>{
  const{nombre,rtn,direccion,telefono,email,limite_credito}=req.body;
  const id=uuid(); run(`INSERT INTO clientes(id,nombre,rtn,direccion,telefono,email,limite_credito)VALUES(?,?,?,?,?,?,?)`,[id,nombre,rtn||'',direccion||'',telefono||'',email||'',limite_credito||0]); saveDB(); res.json({id});
});
app.put('/api/clientes/:id',auth(['admin','supervisor']),(req,res)=>{
  const{nombre,rtn,direccion,telefono,email,limite_credito}=req.body;
  run(`UPDATE clientes SET nombre=?,rtn=?,direccion=?,telefono=?,email=?,limite_credito=? WHERE id=?`,[nombre,rtn||'',direccion||'',telefono||'',email||'',limite_credito||0,req.params.id]); saveDB(); res.json({ok:1});
});
app.delete('/api/clientes/:id',auth(['admin']),(req,res)=>{ run(`UPDATE clientes SET activo=0 WHERE id=?`,[req.params.id]); saveDB(); res.json({ok:1}); });

// ── PROVEEDORES ──
app.get('/api/proveedores',auth(),(req,res)=>res.json(all(`SELECT * FROM proveedores WHERE activo=1 ORDER BY nombre`)));
app.post('/api/proveedores',auth(['admin','supervisor']),(req,res)=>{
  const{nombre,rtn,direccion,telefono,email,contacto,limite_credito}=req.body;
  const id=uuid(); run(`INSERT INTO proveedores(id,nombre,rtn,direccion,telefono,email,contacto,limite_credito)VALUES(?,?,?,?,?,?,?,?)`,[id,nombre,rtn||'',direccion||'',telefono||'',email||'',contacto||'',limite_credito||0]); saveDB(); res.json({id});
});
app.put('/api/proveedores/:id',auth(['admin','supervisor']),(req,res)=>{
  const{nombre,rtn,direccion,telefono,email,contacto,limite_credito}=req.body;
  run(`UPDATE proveedores SET nombre=?,rtn=?,direccion=?,telefono=?,email=?,contacto=?,limite_credito=? WHERE id=?`,[nombre,rtn||'',direccion||'',telefono||'',email||'',contacto||'',limite_credito||0,req.params.id]); saveDB(); res.json({ok:1});
});
app.delete('/api/proveedores/:id',auth(['admin']),(req,res)=>{ run(`UPDATE proveedores SET activo=0 WHERE id=?`,[req.params.id]); saveDB(); res.json({ok:1}); });

// ── VENTAS ──
app.get('/api/ventas',auth(),(req,res)=>{
  const suc=req.query.sucursal_id||req.user.sucursal_id;
  const{fecha_ini,fecha_fin,limite}=req.query;
  let sql=`SELECT v.*,c.nombre as cliente_nombre,c.rtn as cliente_rtn,u.nombre as usuario_nombre FROM ventas v LEFT JOIN clientes c ON c.id=v.cliente_id LEFT JOIN usuarios u ON u.id=v.usuario_id WHERE v.sucursal_id=?`;
  const params=[suc];
  if(fecha_ini){sql+=` AND date(v.fecha)>=?`;params.push(fecha_ini);}
  if(fecha_fin){sql+=` AND date(v.fecha)<=?`;params.push(fecha_fin);}
  sql+=` ORDER BY v.fecha DESC LIMIT ?`;params.push(parseInt(limite)||500);
  res.json(all(sql,params));
});
app.get('/api/ventas/:id/items',auth(),(req,res)=>res.json(all(`SELECT * FROM venta_items WHERE venta_id=?`,[req.params.id])));
app.post('/api/ventas',auth(),(req,res)=>{
  const{cliente_id,items,subtotal,descuento,importe_gravado,importe_exento,importe_exonerado,isv15,isv18,total,exonerado,orden_compra_exenta,constancia_registro,identificativo_sag}=req.body;
  const suc=req.user.sucursal_id;
  const sucursal=get(`SELECT * FROM sucursales WHERE id=?`,[suc]);
  if(!sucursal)return res.status(400).json({error:'Sucursal no encontrada'});
  const lastF=get(`SELECT numero_factura FROM ventas WHERE sucursal_id=? ORDER BY fecha DESC LIMIT 1`,[suc]);
  let nextNum=1;
  if(lastF){const p=lastF.numero_factura.split('-');nextNum=parseInt(p[p.length-1])+1;}
  const numero_factura=`${sucursal.serie}-${String(nextNum).padStart(8,'0')}`;
  const id=uuid();
  db.run(`INSERT INTO ventas(id,numero_factura,sucursal_id,cliente_id,usuario_id,subtotal,descuento,importe_gravado,importe_exento,importe_exonerado,isv15,isv18,total,exonerado,orden_compra_exenta,constancia_registro,identificativo_sag)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,numero_factura,suc,cliente_id,req.user.id,subtotal,descuento||0,importe_gravado||0,importe_exento||0,importe_exonerado||0,isv15||0,isv18||0,total,exonerado?1:0,orden_compra_exenta||'',constancia_registro||'',identificativo_sag||'']);
  for(const item of items){
    const prod=get(`SELECT costo FROM productos WHERE id=?`,[item.id]);
    db.run(`INSERT INTO venta_items(venta_id,producto_id,producto_codigo,producto_nombre,producto_categoria,cantidad,precio_unit,costo_unit,subtotal)VALUES(?,?,?,?,?,?,?,?,?)`,[id,item.id,item.codigo,item.nombre,item.categoria||'',item.cantidad,item.precio,prod?.costo||0,item.cantidad*item.precio]);
    ajustarStock(item.id,suc,item.cantidad,'venta',numero_factura,'Venta POS',req.user.id,prod?.costo||0,item.precio);
  }
  saveDB(); res.json({id,numero_factura});
});
app.post('/api/ventas/:id/anular',auth(['admin','supervisor']),(req,res)=>{
  const v=get(`SELECT * FROM ventas WHERE id=?`,[req.params.id]);
  if(!v)return res.status(404).json({error:'No encontrada'});
  if(v.estado==='anulada')return res.status(400).json({error:'Ya anulada'});
  all(`SELECT * FROM venta_items WHERE venta_id=?`,[req.params.id]).forEach(i=>ajustarStock(i.producto_id,v.sucursal_id,i.cantidad,'entrada',`ANULACION-${v.numero_factura}`,'Anulación',req.user.id,i.costo_unit,i.precio_unit));
  run(`UPDATE ventas SET estado='anulada' WHERE id=?`,[req.params.id]); saveDB(); res.json({ok:1});
});

// ── DEVOLUCIONES ──
app.get('/api/devoluciones',auth(),(req,res)=>{
  const suc=req.user.sucursal_id;
  res.json(all(`SELECT d.*,v.numero_factura,u.nombre as usuario_nombre FROM devoluciones d JOIN ventas v ON v.id=d.venta_id LEFT JOIN usuarios u ON u.id=d.usuario_id WHERE d.sucursal_id=? ORDER BY d.fecha DESC`,[suc]));
});
app.post('/api/devoluciones',auth(['admin','supervisor']),(req,res)=>{
  const{venta_id,items,motivo}=req.body;
  const v=get(`SELECT * FROM ventas WHERE id=?`,[venta_id]);
  if(!v)return res.status(404).json({error:'Venta no encontrada'});
  const id=uuid();
  const total=items.reduce((s,i)=>s+i.cantidad*i.precio_unit,0);
  run(`INSERT INTO devoluciones(id,venta_id,sucursal_id,usuario_id,motivo,total)VALUES(?,?,?,?,?,?)`,[id,venta_id,v.sucursal_id,req.user.id,motivo,total]);
  for(const item of items){
    run(`INSERT INTO devolucion_items(devolucion_id,producto_id,cantidad,precio_unit,subtotal)VALUES(?,?,?,?,?)`,[id,item.producto_id,item.cantidad,item.precio_unit,item.cantidad*item.precio_unit]);
    ajustarStock(item.producto_id,v.sucursal_id,item.cantidad,'devolucion',`DEV-${id}`,motivo,req.user.id,0,item.precio_unit);
  }
  run(`UPDATE ventas SET estado='devolucion_parcial' WHERE id=?`,[venta_id]);
  saveDB(); res.json({id,total});
});
app.get('/api/devoluciones/:id/items',auth(),(req,res)=>res.json(all(`SELECT * FROM devolucion_items WHERE devolucion_id=?`,[req.params.id])));

// ── COMPRAS ──
app.get('/api/compras',auth(),(req,res)=>{
  const suc=req.user.sucursal_id;
  res.json(all(`SELECT c.*,p.nombre as proveedor_nombre,u.nombre as usuario_nombre FROM compras c LEFT JOIN proveedores p ON p.id=c.proveedor_id LEFT JOIN usuarios u ON u.id=c.usuario_id WHERE c.sucursal_id=? ORDER BY c.fecha DESC`,[suc]));
});
app.get('/api/compras/:id/items',auth(),(req,res)=>res.json(all(`SELECT * FROM compra_items WHERE compra_id=?`,[req.params.id])));
app.post('/api/compras',auth(['admin','supervisor']),(req,res)=>{
  const{proveedor_id,items,numero_doc,notas}=req.body;
  const suc=req.user.sucursal_id;
  const id=uuid();
  const subtotal=items.reduce((s,i)=>s+i.cantidad*i.costo_unit,0);
  run(`INSERT INTO compras(id,proveedor_id,sucursal_id,usuario_id,numero_doc,subtotal,isv,total,notas)VALUES(?,?,?,?,?,?,0,?,?)`,[id,proveedor_id,suc,req.user.id,numero_doc||'',subtotal,subtotal,notas||'']);
  for(const item of items){
    const pn=get(`SELECT nombre FROM productos WHERE id=?`,[item.producto_id]);
    run(`INSERT INTO compra_items(compra_id,producto_id,producto_nombre,cantidad,costo_unit,subtotal,cantidad_recibida)VALUES(?,?,?,?,?,?,0)`,[id,item.producto_id,pn?.nombre||'',item.cantidad,item.costo_unit,item.cantidad*item.costo_unit]);
  }
  saveDB(); res.json({id,subtotal});
});
app.post('/api/compras/:id/recibir',auth(['admin','supervisor']),(req,res)=>{
  const{items}=req.body;
  const compra=get(`SELECT * FROM compras WHERE id=?`,[req.params.id]);
  if(!compra)return res.status(404).json({error:'No encontrada'});
  for(const item of items){
    const ci=get(`SELECT * FROM compra_items WHERE id=?`,[item.compra_item_id]);
    if(!ci)continue;
    run(`UPDATE compra_items SET cantidad_recibida=? WHERE id=?`,[(ci.cantidad_recibida||0)+item.cantidad_recibida,item.compra_item_id]);
    run(`UPDATE productos SET costo=? WHERE id=?`,[ci.costo_unit,ci.producto_id]);
    ajustarStock(ci.producto_id,compra.sucursal_id,item.cantidad_recibida,'compra',`COMPRA-${req.params.id}`,'Recepción compra',req.user.id,ci.costo_unit);
  }
  const pend=all(`SELECT * FROM compra_items WHERE compra_id=? AND cantidad_recibida < cantidad`,[req.params.id]);
  run(`UPDATE compras SET estado=? WHERE id=?`,[pend.length===0?'recibida':'parcial',req.params.id]);
  saveDB(); res.json({ok:1});
});

// ── CxC ──
app.get('/api/cxc',auth(),(req,res)=>{
  const suc=req.user.sucursal_id;
  res.json(all(`SELECT cxc.*,c.nombre as cliente_nombre,c.rtn as cliente_rtn FROM cxc LEFT JOIN clientes c ON c.id=cxc.cliente_id WHERE cxc.sucursal_id=? ORDER BY cxc.vencimiento`,[suc]));
});
app.post('/api/cxc',auth(),(req,res)=>{
  const{cliente_id,referencia,monto,vencimiento}=req.body;
  const id=uuid(); run(`INSERT INTO cxc(id,cliente_id,sucursal_id,referencia,monto,saldo,fecha,vencimiento)VALUES(?,?,?,?,?,?,date('now'),?)`,[id,cliente_id,req.user.sucursal_id,referencia||'',monto,monto,vencimiento]); saveDB(); res.json({id});
});
app.post('/api/cxc/:id/pagar',auth(),(req,res)=>{
  const{monto}=req.body;
  const c=get(`SELECT * FROM cxc WHERE id=?`,[req.params.id]);
  if(!c)return res.status(404).json({error:'No encontrada'});
  const ns=Math.max(0,c.saldo-monto);
  run(`UPDATE cxc SET saldo=?,estado=? WHERE id=?`,[ns,ns===0?'pagado':'pendiente',req.params.id]);
  run(`INSERT INTO pagos_cxc(cxc_id,monto,usuario_id)VALUES(?,?,?)`,[req.params.id,monto,req.user.id]);
  run(`UPDATE clientes SET saldo=MAX(0,saldo-?) WHERE id=?`,[monto,c.cliente_id]);
  saveDB(); res.json({saldo:ns});
});
app.delete('/api/cxc/:id',auth(['admin']),(req,res)=>{ run(`DELETE FROM cxc WHERE id=?`,[req.params.id]); saveDB(); res.json({ok:1}); });

// ── CxP ──
app.get('/api/cxp',auth(),(req,res)=>{
  const suc=req.user.sucursal_id;
  res.json(all(`SELECT cxp.*,p.nombre as proveedor_nombre FROM cxp LEFT JOIN proveedores p ON p.id=cxp.proveedor_id WHERE cxp.sucursal_id=? ORDER BY cxp.vencimiento`,[suc]));
});
app.post('/api/cxp',auth(['admin','supervisor']),(req,res)=>{
  const{proveedor_id,referencia,monto,vencimiento}=req.body;
  const id=uuid(); run(`INSERT INTO cxp(id,proveedor_id,sucursal_id,referencia,monto,saldo,fecha,vencimiento)VALUES(?,?,?,?,?,?,date('now'),?)`,[id,proveedor_id,req.user.sucursal_id,referencia||'',monto,monto,vencimiento]); saveDB(); res.json({id});
});
app.post('/api/cxp/:id/pagar',auth(['admin','supervisor']),(req,res)=>{
  const{monto}=req.body;
  const c=get(`SELECT * FROM cxp WHERE id=?`,[req.params.id]);
  if(!c)return res.status(404).json({error:'No encontrada'});
  const ns=Math.max(0,c.saldo-monto);
  run(`UPDATE cxp SET saldo=?,estado=? WHERE id=?`,[ns,ns===0?'pagado':'pendiente',req.params.id]);
  run(`INSERT INTO pagos_cxp(cxp_id,monto,usuario_id)VALUES(?,?,?)`,[req.params.id,monto,req.user.id]);
  run(`UPDATE proveedores SET saldo=MAX(0,saldo-?) WHERE id=?`,[monto,c.proveedor_id]);
  saveDB(); res.json({saldo:ns});
});
app.delete('/api/cxp/:id',auth(['admin']),(req,res)=>{ run(`DELETE FROM cxp WHERE id=?`,[req.params.id]); saveDB(); res.json({ok:1}); });

// ── REPORTES ──
app.get('/api/reportes/ventas_resumen',auth(),(req,res)=>{
  const suc=req.query.sucursal_id||req.user.sucursal_id;
  const{fecha_ini,fecha_fin}=req.query;
  let w=`WHERE v.sucursal_id=? AND v.estado='emitida'`;const p=[suc];
  if(fecha_ini){w+=` AND date(v.fecha)>=?`;p.push(fecha_ini);}
  if(fecha_fin){w+=` AND date(v.fecha)<=?`;p.push(fecha_fin);}
  res.json(get(`SELECT COUNT(*)as total_ventas,SUM(subtotal)as subtotal,SUM(descuento)as descuentos,SUM(isv15)as isv15,SUM(total)as total FROM ventas v ${w}`,p));
});
app.get('/api/reportes/ventas_por_categoria',auth(),(req,res)=>{
  const suc=req.query.sucursal_id||req.user.sucursal_id;
  const{fecha_ini,fecha_fin}=req.query;
  let w=`WHERE v.sucursal_id=? AND v.estado='emitida'`;const p=[suc];
  if(fecha_ini){w+=` AND date(v.fecha)>=?`;p.push(fecha_ini);}
  if(fecha_fin){w+=` AND date(v.fecha)<=?`;p.push(fecha_fin);}
  res.json(all(`SELECT vi.producto_categoria as categoria,SUM(vi.cantidad)as unidades,SUM(vi.subtotal)as total FROM venta_items vi JOIN ventas v ON v.id=vi.venta_id ${w} GROUP BY vi.producto_categoria ORDER BY total DESC`,p));
});
app.get('/api/reportes/ventas_por_mes',auth(),(req,res)=>{
  const suc=req.query.sucursal_id||req.user.sucursal_id;
  res.json(all(`SELECT strftime('%Y-%m',v.fecha)as mes,COUNT(*)as ventas,SUM(v.isv15)as isv,SUM(v.total)as total FROM ventas v WHERE v.sucursal_id=? AND v.estado='emitida' GROUP BY mes ORDER BY mes DESC LIMIT 24`,[suc]));
});
app.get('/api/reportes/articulos_por_dia',auth(),(req,res)=>{
  const suc=req.query.sucursal_id||req.user.sucursal_id;
  const{fecha_ini,fecha_fin}=req.query;
  let w=`WHERE v.sucursal_id=? AND v.estado='emitida'`;const p=[suc];
  if(fecha_ini){w+=` AND date(v.fecha)>=?`;p.push(fecha_ini);}
  if(fecha_fin){w+=` AND date(v.fecha)<=?`;p.push(fecha_fin);}
  res.json(all(`SELECT date(v.fecha)as dia,vi.producto_codigo,vi.producto_nombre,vi.producto_categoria,SUM(vi.cantidad)as unidades,SUM(vi.subtotal)as total FROM venta_items vi JOIN ventas v ON v.id=vi.venta_id ${w} GROUP BY dia,vi.producto_id ORDER BY dia DESC,total DESC`,p));
});
app.get('/api/reportes/inventario',auth(),(req,res)=>{
  const suc=req.query.sucursal_id||req.user.sucursal_id;
  res.json(all(`SELECT p.codigo,p.nombre,p.categoria,p.precio_venta,p.costo,COALESCE(i.stock,0)as stock,COALESCE(i.stock_min,0)as stock_min,COALESCE(i.stock,0)*p.costo as valor_costo,COALESCE(i.stock,0)*p.precio_venta as valor_venta FROM productos p LEFT JOIN inventario i ON i.producto_id=p.id AND i.sucursal_id=? WHERE p.activo=1 ORDER BY p.categoria,p.nombre`,[suc]));
});

// ── CONFIG ──
app.get('/api/config',auth(),(req,res)=>{const r={};all(`SELECT * FROM config`).forEach(x=>r[x.clave]=x.valor);res.json(r);});
app.put('/api/config',auth(['admin']),(req,res)=>{for(const[k,v]of Object.entries(req.body))run(`INSERT OR REPLACE INTO config(clave,valor)VALUES(?,?)`,[k,v]);saveDB();res.json({ok:1});});

// ── SYNC ──
app.get('/api/sync/pendiente/:sid',auth(['admin']),(req,res)=>res.json(all(`SELECT * FROM sync_log WHERE sucursal_id!=? AND sincronizado=0 ORDER BY fecha ASC LIMIT 500`,[req.params.sid])));
app.post('/api/sync/confirmar',auth(['admin']),(req,res)=>{(req.body.ids||[]).forEach(id=>run(`UPDATE sync_log SET sincronizado=1 WHERE id=?`,[id]));saveDB();res.json({ok:1});});
app.get('/api/sync/estado',auth(['admin']),(req,res)=>res.json({pendientes:get(`SELECT COUNT(*)as total FROM sync_log WHERE sincronizado=0`).total,sucursales:all(`SELECT id,nombre FROM sucursales WHERE activa=1`)}));

// ── SPA fallback ──
app.get('/{*path}',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDB().then(()=>{
  app.listen(PORT,'0.0.0.0',()=>{
    console.log(`\n🚀 Metric POS v2.0 → http://localhost:${PORT}`);
    console.log(`   Login: admin / admin123\n`);
  });
}).catch(err=>{console.error(err);process.exit(1);});
