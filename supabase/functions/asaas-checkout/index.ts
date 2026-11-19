import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" }
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } })
const fail = (message, status = 503) => Object.assign(new Error(message), { status })
const plans = { 1: { value: 9.90, cycle: "MONTHLY", label: "Mensal" }, 12: { value: 69.90, cycle: "YEARLY", label: "Anual" } }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (req.method !== "POST") return reply(405, { error: "Use POST." })
  let db, user, sub, token, retain = false
  const release = async () => {
    const r = await db.from("a19_checkout_guard").delete().eq("user_id", user.id).eq("token", token).select("token")
    if (r.error || r.data?.length !== 1) throw fail("Nao foi possivel concluir o controle da tentativa. Contate o suporte.")
    token = null
  }
  try {
    const url = Deno.env.get("SUPABASE_URL")
    const key = Deno.env.get("ASAAS_API_KEY")
    const base = (Deno.env.get("ASAAS_ENV") || "https://api.asaas.com/v3").replace(/\/$/, "")
    if (!key || !["https://api.asaas.com/v3", "https://api-sandbox.asaas.com/v3"].includes(base)) throw fail("Integracao de pagamentos indisponivel.")
    const auth = createClient(url, Deno.env.get("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } })
    const identity = await auth.auth.getUser()
    user = identity.data?.user
    if (identity.error || !user?.id || !user.email) throw fail("Usuario nao autenticado.", 401)
    let body
    try { body = await req.json() } catch { throw fail("JSON invalido.", 400) }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("Requisicao invalida.", 400)
    const cancel = body.action === "cancel"
    const months = Number(body.planMonths ?? 1)
    if (!cancel && ![1, 12].includes(months)) throw fail("Plano invalido.", 400)
    const plan = plans[months]
    db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } })
    const attempt = crypto.randomUUID()
    const locked = await db.from("a19_checkout_guard").insert({ user_id: user.id, token: attempt, operation: cancel ? "cancel" : "subscribe", state: "working" }).select("token")
    if (locked.error?.code === "23505") throw fail("Ja existe uma tentativa em processamento ou em conciliacao. Nao repita a compra; contate o suporte se persistir.", 409)
    if (locked.error || locked.data?.length !== 1 || locked.data[0].token !== attempt) throw fail("Controle de tentativas indisponivel. Nenhuma nova operacao foi iniciada.")
    token = attempt
    const current = await db.from("assinaturas").select("*").eq("user_id", user.id).single()
    if (current.error || !current.data) throw fail("Assinatura local nao localizada. Contate o suporte.", 409)
    sub = current.data
    if (sub.is_admin || sub.status === "courtesy") throw fail("Esta assinatura e administrada pelo suporte.", 409)
    const api = async (path, method = "GET", payload, allow404 = false) => {
      const res = await fetch(base + path, { method, headers: { access_token: key, "Content-Type": "application/json" }, ...(payload ? { body: JSON.stringify(payload) } : {}), redirect: "error", signal: AbortSignal.timeout(20000) })
      if (allow404 && res.status === 404) return { deleted: true, id: sub.asaas_subscription_id, customer: sub.asaas_customer_id }
      let data
      try { data = await res.json() } catch { throw fail("Resposta invalida do Asaas. A operacao precisa ser conferida.", 502) }
      if (!res.ok) throw Object.assign(fail("O Asaas nao aceitou ou nao confirmou a operacao.", 502), { definite: [400, 401, 403, 404, 422].includes(res.status) && Array.isArray(data?.errors) })
      return data
    }
    const mutate = async (path, method, payload) => {
      const previous = retain
      retain = true
      try { return await api(path, method, payload) } catch (e) { if (e.definite) retain = previous; throw e }
    }
    const save = async (patch) => {
      let q = db.from("assinaturas").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", sub.id).eq("user_id", user.id).eq("status", sub.status).eq("is_admin", false)
      for (const k of ["asaas_customer_id", "asaas_subscription_id", "updated_at", "current_period_end", "canceled_at"]) q = sub[k] == null ? q.is(k, null) : q.eq(k, sub[k])
      const r = await q.select("*")
      if (r.error || r.data?.length !== 1) throw fail("Nao foi possivel confirmar a gravacao local. Contate o suporte antes de repetir.")
      sub = r.data[0]
    }
    const checkRemote = (r) => {
      if (r?.id !== sub.asaas_subscription_id || (sub.asaas_customer_id && r.customer !== sub.asaas_customer_id)) throw fail("Vinculo da assinatura precisa de conciliacao.")
    }
    let remote = null
    if (sub.asaas_subscription_id) {
      remote = await api("/subscriptions/" + encodeURIComponent(sub.asaas_subscription_id), "GET", undefined, true)
      checkRemote(remote)
    }
    let result
    if (cancel) {
      if (!remote) throw fail("Nao ha assinatura Asaas vinculada para cancelar.", 409)
      if (!remote.deleted) {
        const removed = await mutate("/subscriptions/" + encodeURIComponent(sub.asaas_subscription_id), "DELETE")
        if (removed?.deleted !== true) throw fail("O Asaas nao confirmou a exclusao da recorrencia.", 502)
      }
      await save({ status: sub.status === "suspended" ? "suspended" : "canceled", canceled_at: sub.canceled_at || new Date().toISOString() })
      retain = false
      result = { success: true, accessUntil: sub.current_period_end }
    } else {
      const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date())
      if (sub.current_period_end && sub.current_period_end >= today) throw fail("Existe periodo pago vigente. Nao foi criada outra assinatura.", 409)
      if (remote && !remote.deleted) {
        if (sub.plan_months !== months || Number(remote.value) !== plan.value || remote.cycle !== plan.cycle) throw fail("Existe outra recorrencia vinculada. Solicite a revisao antes de trocar o plano.", 409)
        if (remote.status !== "ACTIVE") throw fail("A recorrencia existente precisa de revisao. Nao foi criada outra.", 409)
      } else {
        if (!sub.asaas_customer_id) {
          const name = typeof body.name === "string" ? body.name.trim() : ""
          const document = String(body.cpfCnpj || "").replace(/\D/g, "")
          if (name.length < 2 || ![11, 14].includes(document.length)) throw fail("Informe nome e CPF/CNPJ validos.", 400)
          const customer = await mutate("/customers", "POST", { name, email: user.email, cpfCnpj: document, externalReference: "gc:" + token })
          if (typeof customer?.id !== "string" || !/^cus_[A-Za-z0-9_]+$/.test(customer.id)) throw fail("Cliente nao confirmado pelo Asaas.", 502)
          await save({ asaas_customer_id: customer.id })
          retain = false
        }
        const created = await mutate("/subscriptions", "POST", { customer: sub.asaas_customer_id, billingType: "UNDEFINED", value: plan.value, nextDueDate: today, cycle: plan.cycle, description: `Gestao Completa - ${plan.label}`, externalReference: "gc:" + token })
        if (typeof created?.id !== "string" || !/^sub_[A-Za-z0-9_]+$/.test(created.id)) throw fail("Criacao da assinatura precisa ser conferida.", 502)
        await save({ asaas_subscription_id: created.id, plan_months: months, canceled_at: null, status: sub.status === "canceled" ? "active" : sub.status })
        retain = false
      }
      let payments = [], offset = 0
      for (;;) {
        const page = await api(`/subscriptions/${encodeURIComponent(sub.asaas_subscription_id)}/payments?limit=100&offset=${offset}`)
        if (!Array.isArray(page?.data)) throw fail("Lista de cobrancas invalida.", 502)
        payments.push(...page.data)
        if (!page.hasMore) break
        if (!page.data.length || offset >= 900) throw fail("Cobrancas precisam de conciliacao.")
        offset += 100
      }
      const paidCurrent = payments.some(p => {
        if (!["CONFIRMED", "RECEIVED"].includes(p.status)) return false
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate || "")) throw fail("Pagamento confirmado precisa de conciliacao.")
        const d = new Date(p.dueDate + "T12:00:00Z")
        if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== p.dueDate) throw fail("Vencimento precisa de conciliacao.")
        const day = d.getUTCDate()
        d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months)
        d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()))
        return d.toISOString().slice(0, 10) >= today
      })
      if (paidCurrent) throw fail("Pagamento ja identificado. Aguarde a atualizacao do acesso; nao realize outra compra.", 409)
      const invoice = payments.filter(p => ["PENDING", "OVERDUE"].includes(p.status) && !p.deleted && typeof p.invoiceUrl === "string").sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0]
      if (!invoice) throw fail("Link de pagamento ainda nao disponivel. A assinatura existente foi preservada; nao crie outra.", 502)
      const link = new URL(invoice.invoiceUrl)
      if (link.protocol !== "https:" || !(link.hostname === "asaas.com" || link.hostname.endsWith(".asaas.com"))) throw fail("Link de pagamento invalido.", 502)
      result = { invoiceUrl: invoice.invoiceUrl }
    }
    await release()
    return reply(200, result)
  } catch (e) {
    if (token) {
      if (retain) {
        try { await db.from("a19_checkout_guard").update({ state: "uncertain" }).eq("user_id", user.id).eq("token", token) } catch { /* The existing guard still blocks retries. */ }
      } else {
        try { await release() } catch { return reply(503, { error: "Falha ao concluir a tentativa. Contate o suporte antes de repetir." }) }
      }
    }
    return reply(e.status || 503, { error: e.status ? e.message : "Operacao nao confirmada. Contate o suporte antes de repetir." })
  }
})
