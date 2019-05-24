import * as express from "express";
import { Maybe } from "tsmonad";

import Database from "./Database";
import { PublicUser } from "@magda/typescript-common/dist/authorization-api/model";
import { getUserIdHandling } from "@magda/typescript-common/dist/session/GetUserId";
import GenericError from "@magda/typescript-common/dist/authorization-api/GenericError";
import AuthError from "@magda/typescript-common/dist/authorization-api/AuthError";
import { installStatusRouter } from "@magda/typescript-common/dist/express/status";
import NestedSetModelQueryer from "./NestedSetModelQueryer";

export interface ApiRouterOptions {
    database: Database;
    orgQueryer: NestedSetModelQueryer;
    jwtSecret: string;
}

/**
 * @apiDefine Auth Authorization API
 */

export default function createApiRouter(options: ApiRouterOptions) {
    const database = options.database;
    const orgQueryer = options.orgQueryer;

    const router: express.Router = express.Router();

    const status = {
        probes: {
            database: database.check.bind(database)
        }
    };
    installStatusRouter(router, status);
    installStatusRouter(router, status, "/private");
    installStatusRouter(router, status, "/public");

    function handlePromise<T>(
        res: express.Response,
        promise: Promise<Maybe<T>>
    ) {
        return promise
            .then(user =>
                user.caseOf({
                    just: user => res.json(user),
                    nothing: () => res.status(404)
                })
            )
            .catch(e => {
                console.error(e);
                res.status(500);
            })
            .then(() => res.end());
    }

    const MUST_BE_ADMIN = function(req: any, res: any, next: any) {
        //--- private API requires admin level access

        getUserIdHandling(
            req,
            res,
            options.jwtSecret,
            async (userId: string) => {
                try {
                    const user = (await database.getUser(userId)).valueOrThrow(
                        new AuthError(
                            `Cannot locate user record by id: ${userId}`,
                            401
                        )
                    );
                    if (!user.isAdmin)
                        throw new AuthError(
                            "Only admin users are authorised to access this API",
                            403
                        );
                    req.user = user;
                    next();
                } catch (e) {
                    console.warn(e);
                    if (e instanceof AuthError)
                        res.status(e.statusCode).send(e.message);
                    else res.status(401).send("Not authorized");
                }
            }
        );
    };

    router.all("/private/*", MUST_BE_ADMIN);

    router.get("/private/users/lookup", function(req, res) {
        const source = req.query.source;
        const sourceId = req.query.sourceId;

        handlePromise(res, database.getUserByExternalDetails(source, sourceId));
    });

    router.get("/private/users/:userId", function(req, res) {
        const userId = req.params.userId;

        handlePromise(res, database.getUser(userId));
    });

    router.post("/private/users", async function(req, res) {
        try {
            const user = await database.createUser(req.body);
            res.json(user);
            res.status(201);
        } catch (e) {
            console.error(e);
            res.status(500);
        }
        res.end();
    });

    /**
     * @apiGroup Auth
     * @api {get} /v0/auth/users/whoami Get Current User
     * @apiDescription Returns current user
     *
     * @apiSuccessExample {any} 200
     *    {
     *        "id":"...",
     *        "displayName":"Fred Nerk",
     *        "email":"fred.nerk@data61.csiro.au",
     *        "photoURL":"...",
     *        "source":"google",
     *        "isAdmin": true
     *    }
     *
     * @apiErrorExample {json} 200
     *    {
     *      "isError": true,
     *      "errorCode": 401, //--- or 404, 500 depends on error type
     *      "errorMessage": "Not authorized"
     *    }
     */

    router.get("/public/users/whoami", async function(req, res) {
        try {
            res.set({
                "Cache-Control": "no-cache, no-store, must-revalidate",
                Pragma: "no-cache",
                Expires: "0"
            });
            const currentUserInfo = await database.getCurrentUserInfo(
                req,
                options.jwtSecret
            );

            res.json(currentUserInfo);
        } catch (e) {
            if (e instanceof GenericError) {
                res.json(e.toData());
            } else {
                console.error(
                    `Error happened when processed \`/public/users/whoami\`: ${e}`
                );
                res.status(500).send("Internal Server Error.");
            }
        }
    });

    router.get("/public/users/all", MUST_BE_ADMIN, async (req, res) => {
        const items = await database.getUsers();
        res.status(200)
            .json({
                items
            })
            .end();
    });

    /**
     * @apiGroup Auth
     * @api {get} /v0/auth/users/:userId Get User By Id
     * @apiDescription Returns user by id
     *
     * @apiParam {string} userId id of user
     *
     * @apiSuccessExample {any} 200
     *    {
     *        "id":"...",
     *        "displayName":"Fred Nerk",
     *        "photoURL":"...",
     *        "isAdmin": true
     *    }
     *
     *
     * @apiErrorExample {json} 500
     *    Nothing
     */
    router.get("/public/users/:userId", (req, res) => {
        res.set({
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
            Expires: "0"
        });
        const userId = req.params.userId;
        const getPublicUser = database.getUser(userId).then(userMaybe =>
            userMaybe.map(user => {
                const publicUser: PublicUser = {
                    id: user.id,
                    photoURL: user.photoURL,
                    displayName: user.displayName,
                    isAdmin: user.isAdmin
                };

                return publicUser;
            })
        );

        handlePromise(res, getPublicUser);
    });

    router.put("/public/users/:userId", MUST_BE_ADMIN, async (req, res) => {
        const userId = req.params.userId;
        if (userId === req.user.id) {
            throw new AuthError(
                "Cannot change your own details through this endpoint",
                403
            );
        }
        // extract fields
        const { isAdmin } = req.body;
        const update = { isAdmin };
        // update
        await database.updateUser(userId, update);
        res.status(200).json({
            result: "SUCCESS"
        });
    });

    router.get("/public/orgUnits/rootNode", MUST_BE_ADMIN, async (req, res) => {
        try {
            const node = await orgQueryer.getRootNode();
            if (!node) throw new Error("Cannot locate the root tree node.");
            res.status(200).json(node);
        } catch (e) {
            res.status(500).send(`Failed to retrieve tree root node: ${e}`);
        }
    });

    router.get(
        "/public/orgUnits/immediateChildren/:nodeId",
        MUST_BE_ADMIN,
        async (req, res) => {
            try {
                const nodeId = req.params.nodeId;
                const nodes = await orgQueryer.getImmediateChildren(nodeId);
                res.status(200).json(nodes);
            } catch (e) {
                res.status(500).send(`Error: ${e}`);
            }
        }
    );

    router.get(
        "/public/orgUnits/allChildren/:nodeId",
        MUST_BE_ADMIN,
        async (req, res) => {
            try {
                const nodeId = req.params.nodeId;
                const nodes = await orgQueryer.getAllChildren(nodeId);
                res.status(200).json(nodes);
            } catch (e) {
                res.status(500).send(`Error: ${e}`);
            }
        }
    );

    router.get(
        "/public/orgUnits/nodeById/:nodeId",
        MUST_BE_ADMIN,
        async (req, res) => {
            try {
                const nodeId = req.params.nodeId;
                const node = await orgQueryer.getNodeById(nodeId);
                if (!node)
                    throw new Error(
                        "Cannot locate node record with ID: " + nodeId
                    );
                res.status(200).json(node);
            } catch (e) {
                res.status(500).send(`Error: ${e}`);
            }
        }
    );

    router.get(
        "/public/orgUnits/nodesByName/:nodeName",
        MUST_BE_ADMIN,
        async (req, res) => {
            try {
                const nodeName = req.params.nodeName;
                const nodes = await orgQueryer.getNodesByName(nodeName);
                res.status(200).json(nodes);
            } catch (e) {
                res.status(500).send(`Error: ${e}`);
            }
        }
    );

    router.post(
        "/public/orgUnits/createRootNode",
        MUST_BE_ADMIN,
        async (req, res) => {
            try {
                const nodeId = await orgQueryer.createRootNode(req.body);
                res.status(200).json(nodeId);
            } catch (e) {
                res.status(500).send(`Error: ${e}`);
            }
        }
    );

    router.post(
        "/public/orgUnits/insertNode/:nodeId",
        MUST_BE_ADMIN,
        async (req, res) => {
            try {
                const nodeId = req.params.nodeId;
                const newNodeId = await orgQueryer.insertNode(nodeId, req.body);
                res.status(200).json(newNodeId);
            } catch (e) {
                res.status(500).send(`Error: ${e}`);
            }
        }
    );

    router.put(
        "/public/orgUnits/updateNode/:nodeId",
        MUST_BE_ADMIN,
        async (req, res) => {
            try {
                const nodeId = req.params.nodeId;
                await orgQueryer.updateNode(nodeId, req.body);
                res.status(200).json(nodeId);
            } catch (e) {
                res.status(500).send(`Error: ${e}`);
            }
        }
    );

    router.post(
        "/public/orgUnits/deleteSubTree/:nodeId",
        MUST_BE_ADMIN,
        async (req, res) => {
            try {
                const nodeId = req.params.nodeId;
                await orgQueryer.deleteSubTree(nodeId, true);
                res.status(200).json(true);
            } catch (e) {
                res.status(500).send(`Error: ${e}`);
            }
        }
    );

    router.post(
        "/public/orgUnits/deleteNode/:nodeId",
        MUST_BE_ADMIN,
        async (req, res) => {
            try {
                const nodeId = req.params.nodeId;
                await orgQueryer.deleteNode(nodeId);
                res.status(200).json(true);
            } catch (e) {
                res.status(500).send(`Error: ${e}`);
            }
        }
    );

    router.post(
        "/public/orgUnits/moveSubTreeTo/:nodeId/:newParentId",
        MUST_BE_ADMIN,
        async (req, res) => {
            try {
                const nodeId = req.params.nodeId;
                const newParentId = req.params.newParentId;
                await orgQueryer.moveSubTreeTo(nodeId, newParentId);
                res.status(200).json(true);
            } catch (e) {
                res.status(500).send(`Error: ${e}`);
            }
        }
    );

    // This is for getting a JWT in development so you can do fake authenticated requests to a local server.
    if (process.env.NODE_ENV !== "production") {
        router.get("public/jwt", function(req, res) {
            res.status(200);
            res.write("X-Magda-Session: " + req.header("X-Magda-Session"));
            res.send();
        });
    }

    return router;
}
