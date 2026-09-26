const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://hypersagetech:7oDb5EZK9YnnBSkl@salon.ovdjb.mongodb.net/subhamxerox?retryWrites=true&w=majority&appName=subhamxerox";
const BACKUP_DIR = path.join(__dirname, '..', 'backup');

async function exportBackup() {
  console.log("Connecting to MongoDB...");
  console.log("URI:", MONGO_URI.replace(/:([^:@]+)@/, ':****@'));

  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected successfully.");

    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    console.log(`Found ${collections.length} collection(s).`);

    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const summary = {
      timestamp: new Date().toISOString(),
      database: db.databaseName,
      collections: {}
    };

    let totalDocs = 0;

    for (const col of collections) {
      const colName = col.name;
      console.log(`Exporting collection: ${colName}...`);
      const docs = await db.collection(colName).find({}).toArray();
      
      const filePath = path.join(BACKUP_DIR, `${colName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(docs, null, 2), 'utf-8');
      
      console.log(`  -> Saved ${docs.length} documents to ${colName}.json`);
      summary.collections[colName] = docs.length;
      totalDocs += docs.length;
    }

    summary.totalDocuments = totalDocs;
    fs.writeFileSync(
      path.join(BACKUP_DIR, '_summary.json'),
      JSON.stringify(summary, null, 2),
      'utf-8'
    );

    console.log("\n==========================================");
    console.log(`Backup completed successfully!`);
    console.log(`Total Collections: ${collections.length}`);
    console.log(`Total Documents: ${totalDocs}`);
    console.log(`Backup Location: ${BACKUP_DIR}`);
    console.log("==========================================");

  } catch (err) {
    console.error("Backup failed with error:", err);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB.");
  }
}

exportBackup();
