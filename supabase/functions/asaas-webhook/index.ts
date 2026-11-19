import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const sameToken = async (a, b) => {
  const hash = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))
  const [x, y] = await Promise.all([hash(a), hash(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}
const addMonths = (date, months) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("Invalid date")
  const d = new Date(date + "T12:00:00Z")
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== date) throw new Error("Invalid date")
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error("Invalid plan")
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.toISOString().slice(0, 10)
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "Use POST." })
  const token = Deno.env.get("ASAAS_WEBHOOK_TOKEN")
  if (!token) return reply(503, { error: "Webhook nao configurado." })
  const provided = req.headers.get("asaas-access-token") || ""
  if (!provided || !(await sameToken(provided, token))) return reply(401, { error: "Token invalido." })
  let body
  try { body = await req.json() } catch { return reply(400, { error: "JSON invalido." }) }
  if (!body || typeof body !== "object") return reply(400, { error: "Evento invalido." })
  const paid = ["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"].includes(body.event)
  const deleted = body.event === "SUBSCRIPTION_DELETED"
  if (!paid && !deleted) return reply(200, { received: true, ignored: true })
  try {
    let payment = body.payment
    let customerId = paid ? payment?.customer : body.subscription?.customer
    let subscriptionId = paid ? payment?.subscription : body.subscription?.id
    if (paid) {
      if (typeof payment?.id !== "string" || !/^pay_[A-Za-z0-9_]+$/.test(payment.id)) return reply(400, { error: "Cobranca invalida." })
      const apiKey = Deno.env.get("ASAAS_API_KEY")
      const base = (Deno.env.get("ASAAS_ENV") || "https://api.asaas.com/v3").replace(/\/$/, "")
      if (!apiKey || !["https://api.asaas.com/v3", "https://api-sandbox.asaas.com/v3"].includes(base)) throw new Error("API configuration")
      const res = await fetch(`${base}/payments/${encodeURIComponent(payment.id)}`, {
        headers: { access_token: apiKey }, redirect: "error", signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) throw new Error("Payment lookup")
      const canonical = await res.json()
      if (canonical.id !== payment.id) throw new Error("Payment mismatch")
      if (!["CONFIRMED", "RECEIVED"].includes(canonical.status)) return reply(200, { received: true, ignored: true })
      payment = canonical
      customerId = payment.customer
      subscriptionId = payment.subscription
    }
    if (typeof customerId !== "string" || typeof subscriptionId !== "string") return reply(400, { error: "Assinatura invalida." })
    const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } })
    const { data: sub, error } = await db.from("assinaturas").select("*").eq("asaas_customer_id", customerId).maybeSingle()
    if (error || !sub) throw new Error("Subscription lookup")
    if (sub.asaas_subscription_id !== subscriptionId || sub.is_admin || sub.status === "courtesy") return reply(200, { received: true, ignored: true })
    const now = new Date()
    let patch
    if (paid) {
      if (sub.asaas_payment_id === payment.id) return reply(200, { received: true, duplicated: true })
      const end = addMonths(payment.dueDate, sub.plan_months)
      if (sub.current_period_end && end < sub.current_period_end) return reply(200, { received: true, ignored: true })
      patch = {
        status: sub.canceled_at || sub.status === "canceled" ? "canceled" : "active",
        asaas_payment_id: payment.id, current_period_end: end,
        suspended_at: null, purge_at: null, updated_at: now.toISOString(),
      }
    } else {
      if (sub.status === "suspended") return reply(200, { received: true, duplicated: true })
      const limit = sub.current_period_end ? new Date(sub.current_period_end + "T23:59:59Z") : new Date(now)
      limit.setUTCDate(limit.getUTCDate() + 3)
      if (!Number.isFinite(limit.getTime())) throw new Error("Invalid period")
      patch = { status: "canceled", canceled_at: sub.canceled_at || now.toISOString(), updated_at: now.toISOString() }
      if (now > limit) Object.assign(patch, {
        status: "suspended", suspended_at: sub.suspended_at || now.toISOString(),
        purge_at: sub.purge_at || new Date(now.getTime() + 90 * 86400000).toISOString(),
      })
    }
    let update = db.from("assinaturas").update(patch).eq("id", sub.id)
      .eq("asaas_customer_id", customerId).eq("asaas_subscription_id", subscriptionId)
      .eq("status", sub.status).eq("is_admin", false).eq("plan_months", sub.plan_months)
    for (const field of ["updated_at", "current_period_end", "canceled_at", "asaas_payment_id"]) {
      update = sub[field] == null ? update.is(field, null) : update.eq(field, sub[field])
    }
    const result = await update.select("id")
    if (result.error || result.data?.length !== 1) throw new Error("Update failed or concurrent change")
    return reply(200, { received: true })
  } catch {
    return reply(503, { error: "Evento nao processado. Tente novamente." })
  }
})
