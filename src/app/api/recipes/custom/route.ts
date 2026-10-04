import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CUSTOM AI RECIPES — persistence for the crafting panel's recipe book.
 *
 * GET              → every AI-forged recipe (newest first), raw DB rows.
 * DELETE ?recipeId → remove one forged recipe from the book.
 *
 * The client assembles the rows into CraftRecipe-shaped objects (pattern/
 * keyMap/ins are JSON-encoded strings in SQLite).
 */
export async function GET() {
  try {
    const recipes = await db.customRecipe.findMany({
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ ok: true, recipes });
  } catch (error) {
    console.error("[recipes/custom GET]", error);
    return NextResponse.json(
      { ok: false, error: "Could not load forged recipes" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const recipeId = request.nextUrl.searchParams.get("recipeId")?.trim() ?? "";
  if (!recipeId) {
    return NextResponse.json(
      { ok: false, error: "recipeId required" },
      { status: 400 }
    );
  }
  try {
    await db.customRecipe.deleteMany({ where: { recipeId } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[recipes/custom DELETE]", error);
    return NextResponse.json(
      { ok: false, error: "Could not remove recipe" },
      { status: 500 }
    );
  }
}
