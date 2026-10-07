import { bot } from "@/lib/telegram";
import { NextRequest } from "next/server";

export async function POST(req: Request) {
  const update = await req.json();

  await bot.init();
  await bot.handleUpdate(update);

  return Response.json({ ok: true });
}
