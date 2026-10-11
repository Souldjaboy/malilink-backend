// Application témoin (Triangle, HAFIYA) : ne doit jamais être redémarrée.
require("http").createServer((q, r) => r.end(process.env.NOM_TEMOIN || "temoin")).listen(Number(process.env.PORT));
