export async function parseJsonBody<T>(res: Response): Promise<T> {
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`invalid JSON response (${text.slice(0, 120)})`)
  }
}
