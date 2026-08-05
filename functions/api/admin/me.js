// GET /api/admin/me — who am I? Used by the dashboard to bounce to login.

export async function onRequestGet({ data }) {
  return Response.json({ email: data.user.email });
}
