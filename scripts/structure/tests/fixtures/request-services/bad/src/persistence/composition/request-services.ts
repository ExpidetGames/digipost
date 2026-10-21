import { cache } from "react";
import { createRequestServices } from "./create-request-services";

export const getRequestServices = cache(createRequestServices);
