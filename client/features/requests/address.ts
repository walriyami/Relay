/** The address of a request's received files, so a notice can open them. */
export const requestAddress = (id: string) => `/requests/${encodeURIComponent(id)}`;
