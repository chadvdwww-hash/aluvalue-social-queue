// Small Buffer client. No dependencies. Buffer's Public API token only works on this endpoint.
const ENDPOINT = 'https://api.buffer.com/graphql'

export class BufferError extends Error {}

export async function gql(token, query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { throw new BufferError(`HTTP ${res.status}: ${text.slice(0, 300)}`) }
  if (body.errors?.length) throw new BufferError(body.errors.map((e) => e.message).join(' | '))
  if (!body.data) throw new BufferError(`empty response: ${text.slice(0, 300)}`)
  return body.data
}

export async function getOrganizationId(token) {
  const d = await gql(token, `{ account { organizations { id name } } }`)
  const orgs = d.account?.organizations || []
  if (!orgs.length) throw new BufferError('no organizations on this Buffer account')
  return orgs[0].id
}

// Channel ids change whenever a channel is reconnected, so always read them fresh.
export async function getChannels(token, organizationId) {
  const d = await gql(
    token,
    `query($input: ChannelsInput!) { channels(input: $input) {
       id name service type serviceId isDisconnected isLocked } }`,
    { input: { organizationId } },
  )
  return d.channels || []
}

export async function listPosts(token, organizationId, status) {
  const out = []
  let after = null
  do {
    const d = await gql(
      token,
      `query($input: PostsInput!, $first: Int, $after: String) {
         posts(input: $input, first: $first, after: $after) {
           edges { node { id status dueAt channelId } }
           pageInfo { hasNextPage endCursor } } }`,
      { input: { organizationId, filter: { status } }, first: 100, after },
    )
    for (const e of d.posts?.edges || []) out.push(e.node)
    after = d.posts?.pageInfo?.hasNextPage ? d.posts.pageInfo.endCursor : null
  } while (after)
  return out
}

export async function createPost(token, input) {
  const d = await gql(
    token,
    `mutation($input: CreatePostInput!) { createPost(input: $input) {
       __typename
       ... on PostActionSuccess { post { id status dueAt channelId } }
       ... on MutationError { message } } }`,
    { input },
  )
  const r = d.createPost
  if (r.__typename === 'PostActionSuccess') return { ok: true, post: r.post }
  return { ok: false, type: r.__typename, message: r.message || 'unknown error' }
}

export async function deletePost(token, id) {
  const d = await gql(
    token,
    `mutation($input: DeletePostInput!) { deletePost(input: $input) {
       __typename ... on MutationError { message } } }`,
    { input: { id } },
  )
  return d.deletePost.__typename
}
