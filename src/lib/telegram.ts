import { Bot, InlineKeyboard } from "grammy";
import { dbConnect } from "./db";
import { Category, Product, Settings, User, Deposit } from "./models";
import QRCode from "qrcode";
import crypto from "crypto";
import { createCasakuQR } from "./casaku";

export const bot = new Bot(process.env.BOT_TOKEN || "");

type StoreSettings = {
  storeName: string;
  tagline: string;
  welcomeText: string;
};

type CategoryDoc = {
  _id: any;
  name: string;
  emoji: string;
  active: boolean;
};

type ProductDoc = {
  _id: any;
  categoryId: any;
  name: string;
  description: string;
  price: number;
  stock: number;
  imageUrl: string;
  active: boolean;
};

type UserDoc = {
  _id: any;
  telegramId: string;
  username?: string;
  name?: string;
  balance: number;
};

const mainKeyboard = new InlineKeyboard()
  .text("🛍 Produk", "categories")
  .text("💰 Saldo", "balance")
  .row()
  .text("➕ Deposit", "deposit")
  .text("📦 Pesanan", "orders")
  .row()
  .text("ℹ️ Bantuan", "help");

async function settings(): Promise<StoreSettings> {
  await dbConnect();

  const doc = (await Settings.findOne({ key: "main" })
    .lean()
    .exec()) as any;

  return {
    storeName:
      typeof doc?.storeName === "string"
        ? doc.storeName
        : process.env.STORE_NAME || "ServicesId Store",
    tagline:
      typeof doc?.tagline === "string"
        ? doc.tagline
        : process.env.STORE_TAGLINE || "Belanja produk digital dengan cepat & aman",
    welcomeText:
      typeof doc?.welcomeText === "string"
        ? doc.welcomeText
        : "Selamat datang di ServicesId Store 💚",
  };
}

async function upsertUser(ctx: any) {
  const from = ctx.from;
  if (!from) return;

  await dbConnect();

  await User.updateOne(
    { telegramId: String(from.id) },
    {
      $set: {
        username: from.username || "",
        name: `${from.first_name || ""} ${from.last_name || ""}`.trim(),
      },
    },
    { upsert: true }
  );
}

bot.command("start", async (ctx) => {
  await upsertUser(ctx);
  const s = await settings();

  await ctx.reply(
    `🟩 *${s.storeName}*\n\n${s.welcomeText || s.tagline}\n\nPilih menu di bawah. Semua transaksi tercatat otomatis.`,
    {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard,
    }
  );
});

bot.callbackQuery("categories", async (ctx) => {
  await ctx.answerCallbackQuery();
  await dbConnect();

  const cats = (await Category.find({ active: true })
    .sort({ name: 1 })
    .lean()
    .exec()) as unknown as CategoryDoc[];

  const kb = new InlineKeyboard();

  for (const c of cats) {
    kb.text(`${c.emoji} ${c.name}`, `cat:${String(c._id)}`).row();
  }

  kb.text("⬅️ Menu", "home");

  await ctx.editMessageText("🛍 *Pilih kategori produk:*", {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

bot.callbackQuery(/^cat:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await dbConnect();

  const products = (await Product.find({
    categoryId: ctx.match[1],
    active: true,
  })
    .sort({ name: 1 })
    .lean()
    .exec()) as unknown as ProductDoc[];

  const kb = new InlineKeyboard();

  for (const p of products) {
    kb.text(
      `${p.name} — Rp${p.price.toLocaleString("id-ID")}`,
      `product:${String(p._id)}`
    ).row();
  }

  kb.text("⬅️ Kategori", "categories");

  await ctx.editMessageText(
    products.length ? "📦 *Pilih produk:*" : "Belum ada produk di kategori ini.",
    {
      parse_mode: "Markdown",
      reply_markup: kb,
    }
  );
});

bot.callbackQuery(/^product:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await dbConnect();

  const p = (await Product.findById(ctx.match[1])
    .lean()
    .exec()) as unknown as ProductDoc | null;

  if (!p || !p.active) {
    await ctx.reply("Produk tidak tersedia.");
    return;
  }

  const kb = new InlineKeyboard()
    .text("🛒 Beli", `buy:${String(p._id)}`)
    .text("⬅️ Kembali", "categories");

  await ctx.editMessageText(
    `🟩 *${p.name}*\n\n${p.description || "Produk digital."}\n\n💵 Harga: *Rp${p.price.toLocaleString("id-ID")}*\n📦 Stok: ${p.stock}`,
    {
      parse_mode: "Markdown",
      reply_markup: kb,
    }
  );
});

bot.callbackQuery("balance", async (ctx) => {
  await ctx.answerCallbackQuery();
  await dbConnect();

  const u = (await User.findOne({
    telegramId: String(ctx.from.id),
  })
    .lean()
    .exec()) as unknown as UserDoc | null;

  await ctx.editMessageText(
    `💰 *Saldo Anda*\n\nRp${(u?.balance || 0).toLocaleString("id-ID")}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("➕ Deposit", "deposit")
        .text("⬅️ Menu", "home"),
    }
  );
});

bot.callbackQuery("deposit", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.editMessageText(
    "💳 *Deposit*\n\nKirim nominal dengan format:\n`deposit 10000`\n\nContoh: `deposit 25000`",
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Menu", "home"),
    }
  );
});

bot.hears(/^deposit\s+(\d+)$/i, async (ctx) => {
  if (!ctx.from) {
    await ctx.reply("Data pengguna Telegram tidak tersedia.");
    return;
  }

  await upsertUser(ctx);

  const amount = Number(ctx.match[1]);

  if (amount < 1000) {
    await ctx.reply("Minimal deposit Rp1.000.");
    return;
  }

  await dbConnect();

  const reference = `SID-${Date.now()}-${crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase()}`;

  const pay = await createCasakuQR({
    amount,
    reference,
    customerId: String(ctx.from.id),
  });

  const qr = pay.qrImage || (await QRCode.toDataURL(pay.qrText));

  await Deposit.create({
    telegramId: String(ctx.from.id),
    amount,
    reference,
    status: "PENDING",
    qrText: pay.qrText,
    qrImage: qr,
    gatewayId: pay.gatewayId,
    expiresAt: pay.expiresAt,
  });

  await ctx.replyWithPhoto(qr, {
    caption:
      `🟩 *Pembayaran Deposit*\n\nNominal: *Rp${amount.toLocaleString(
        "id-ID"
      )}*\nRef: \`${reference}\`\n\nScan QR lalu bayar. Saldo akan bertambah otomatis setelah Casaku mengirim status PAID.`,
    parse_mode: "Markdown",
  });
});

bot.callbackQuery("help", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.editMessageText(
    "ℹ️ *Bantuan ServicesId Store*\n\n🛍 Produk — lihat katalog\n💰 Saldo — cek saldo\n➕ Deposit — isi saldo\n📦 Pesanan — riwayat pesanan\n\nJika pembayaran sudah sukses tetapi saldo belum masuk, hubungi admin.",
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("⬅️ Menu", "home"),
    }
  );
});

bot.callbackQuery("home", async (ctx) => {
  await ctx.answerCallbackQuery();

  const s = await settings();

  await ctx.editMessageText(
    `🟩 *${s.storeName}*\n\n${s.welcomeText || s.tagline}`,
    {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard,
    }
  );
});

bot.callbackQuery("orders", async (ctx) => {
  await ctx.answerCallbackQuery();

  await ctx.reply(
    "📦 Modul pesanan siap diperluas setelah alur produk digital/fulfillment Anda ditentukan."
  );
});

bot.callbackQuery(/^buy:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await dbConnect();

  const p = await Product.findById(ctx.match[1]);
  const u = await User.findOne({ telegramId: String(ctx.from.id) });

  if (!p || !u || !p.active) {
    await ctx.reply("Produk tidak tersedia.");
    return;
  }

  if ((u.balance || 0) < p.price) {
    await ctx.reply("Saldo tidak cukup. Silakan deposit terlebih dahulu.");
    return;
  }

  if (p.stock <= 0) {
    await ctx.reply("Stok habis.");
    return;
  }

  u.balance -= p.price;
  p.stock -= 1;

  await u.save();
  await p.save();

  await ctx.reply(
    `✅ Pembelian berhasil!\n\n${p.name}\nHarga: Rp${p.price.toLocaleString(
      "id-ID"
    )}\n\n*Catatan:* sambungkan fulfillment digital Anda pada model Order untuk mengirim produk otomatis.`,
    { parse_mode: "Markdown" }
  );
});

export function webhookPath() {
  return `/api/telegram`;
}
